import { getCurrentUser } from "aws-amplify/auth";

import { client } from "../lib/client";
import {
    calculateRouteDistanceMeters,
    getRoutePeriod,
    normalizeRouteLogs,
} from "../lib/locationRoute";
import {
    type ActivityType,
    classifyActivitySession,
    isAggregationTargetActivityType,
    normalizeActivityType,
} from "./activityClassificationService";
import {
    createMonthKey,
    recalculateUserActivityAggregates,
} from "./userActivityAggregationService";

type ListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

type SessionLogItem = {
    id: string;
    userId: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: string;
    recordingSessionId?: string | null;
    recordingSessionName?: string | null;
    sharedOwners?: string[] | null;
    batteryLevel?: number | null;
};

export async function upsertRecordingSessionSummary(
    recordingSessionId: string,
    recordingSessionName: string | null,
    shareOwnerValues: string[] = [],
    recordingIntervalMs?: number | null,
    recordingDistanceMeters?: number | null,
    options?: { skipAggregation?: boolean },
) {
    const logs = await listLocationLogsBySessionId(recordingSessionId);
    const routeLogs = normalizeRouteLogs(logs);

    if (routeLogs.length === 0) {
        return;
    }

    const { startAt, endAt } = getRoutePeriod(routeLogs);

    if (!startAt || !endAt) {
        return;
    }

    const currentUser = await getCurrentUser();
    const firstLog = routeLogs[0];
    const lastLog = routeLogs[routeLogs.length - 1];
    const distanceMeters = calculateRouteDistanceMeters(routeLogs);
    const classification = classifyActivitySession(logs);

    const batteryLogs = [...logs]
        .filter(
            (log) =>
                typeof log.batteryLevel === "number" &&
                Number.isFinite(log.batteryLevel),
        )
        .sort(
            (a, b) =>
                new Date(a.recordedAt).getTime() -
                new Date(b.recordedAt).getTime(),
        );

    const sharedOwnersFromLogs = routeLogs.flatMap((log) =>
        Array.isArray(log.sharedOwners)
            ? log.sharedOwners.filter(
                  (owner): owner is string =>
                      typeof owner === "string" && owner.length > 0,
              )
            : [],
    );

    const summaryName =
        recordingSessionName ??
        lastLog.recordingSessionName ??
        firstLog.recordingSessionName ??
        "自動記録セッション";

    const model = client.models.RecordingSession as any;
    const existingResult = (await model.list({
        filter: { recordingSessionId: { eq: recordingSessionId } },
        limit: 1,
    })) as ListResult;

    if (existingResult.errors) {
        throw new Error(
            `RecordingSession list failed: ${JSON.stringify(existingResult.errors)}`,
        );
    }

    const existing = existingResult.data?.[0];
    const existingSharedOwners = Array.isArray(existing?.sharedOwners)
        ? existing.sharedOwners.filter(
              (owner: unknown): owner is string =>
                  typeof owner === "string" && owner.length > 0,
          )
        : [];

    const sharedOwners = Array.from(
        new Set([
            ...existingSharedOwners,
            ...sharedOwnersFromLogs,
            ...shareOwnerValues.filter(Boolean),
        ]),
    );

    const useManualClassification = existing?.classificationSource === "MANUAL";
    const activityType = useManualClassification
        ? normalizeActivityType(existing?.activityType)
        : classification.activityType;
    const isAggregationTarget = useManualClassification
        ? isAggregationTargetActivityType(activityType)
        : classification.isAggregationTarget;

    const payload = {
        recordingSessionId,
        userId: currentUser.userId,
        recordingSessionName: summaryName,
        startedAt: startAt,
        endedAt: endAt,
        distanceMeters,
        pointCount: routeLogs.length,
        startBatteryLevel: batteryLogs[0]?.batteryLevel ?? null,
        endBatteryLevel:
            batteryLogs[batteryLogs.length - 1]?.batteryLevel ?? null,
        sharedOwners,
        recordingIntervalMs:
            typeof recordingIntervalMs === "number"
                ? recordingIntervalMs
                : (existing?.recordingIntervalMs ?? null),
        recordingDistanceMeters:
            typeof recordingDistanceMeters === "number"
                ? recordingDistanceMeters
                : (existing?.recordingDistanceMeters ?? null),
        activityType,
        isAggregationTarget,
        classificationSource: useManualClassification ? "MANUAL" : "AUTO",
        classificationReason: useManualClassification
            ? (existing?.classificationReason ?? "手動で区分を変更しました。")
            : classification.classificationReason,
        averageSpeedKmh: classification.averageSpeedKmh,
        maxSpeedKmh: classification.maxSpeedKmh,
        movingDurationSeconds: classification.movingDurationSeconds,
        monthKey: createMonthKey(endAt),
    };

    const result = existing?.id
        ? await model.update({ id: existing.id, ...payload })
        : await model.create(payload);

    if (result.errors) {
        throw new Error(
            `RecordingSession save failed: ${JSON.stringify(result.errors)}`,
        );
    }

    await updateLocationLogClassification(
        logs,
        activityType,
        isAggregationTarget,
    );

    if (!options?.skipAggregation) {
        await recalculateUserActivityAggregates(currentUser.userId);
    }
}

export async function updateRecordingSessionActivityType(
    recordingSessionId: string,
    activityType: ActivityType,
): Promise<void> {
    const currentUser = await getCurrentUser();
    const model = client.models.RecordingSession as any;
    const result = (await model.list({
        filter: { recordingSessionId: { eq: recordingSessionId } },
        limit: 1,
    })) as ListResult;

    if (result.errors || !result.data?.[0]?.id) {
        throw new Error("対象のRecordingSessionを取得できませんでした。");
    }

    const session = result.data[0];

    if (session.userId !== currentUser.userId) {
        throw new Error("自分以外のセッション区分は変更できません。");
    }

    const isAggregationTarget = isAggregationTargetActivityType(activityType);

    const updateResult = await model.update({
        id: session.id,
        activityType,
        isAggregationTarget,
        classificationSource: "MANUAL",
        classificationReason: "ユーザーが手動で区分を変更しました。",
    });

    if (updateResult.errors) {
        throw new Error(
            `RecordingSession classification update failed: ${JSON.stringify(
                updateResult.errors,
            )}`,
        );
    }

    const logs = await listLocationLogsBySessionId(recordingSessionId);
    await updateLocationLogClassification(
        logs,
        activityType,
        isAggregationTarget,
    );
    await recalculateUserActivityAggregates(currentUser.userId);
}

export async function recalculateCurrentUserActivityAggregates(): Promise<void> {
    const currentUser = await getCurrentUser();
    await recalculateUserActivityAggregates(currentUser.userId);
}

async function updateLocationLogClassification(
    logs: SessionLogItem[],
    activityType: ActivityType,
    isAggregationTarget: boolean,
): Promise<void> {
    const model = client.models.LocationLog as any;

    for (let index = 0; index < logs.length; index += 25) {
        const batch = logs.slice(index, index + 25);
        const results = await Promise.all(
            batch.map((log) =>
                model.update({
                    id: log.id,
                    activityType,
                    isAggregationTarget,
                }),
            ),
        );

        if (results.some((result) => result.errors)) {
            throw new Error("LocationLogの区分更新に失敗しました。");
        }
    }
}

async function listLocationLogsBySessionId(
    recordingSessionId: string,
): Promise<SessionLogItem[]> {
    const allData: any[] = [];
    let nextToken: string | null = null;
    const model = client.models.LocationLog as any;

    do {
        const result = (await model.list({
            filter: { recordingSessionId: { eq: recordingSessionId } },
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(
                `LocationLog session list failed: ${JSON.stringify(result.errors)}`,
            );
        }

        allData.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    return allData
        .map((item) => ({
            id: item.id,
            userId: item.userId ?? "",
            latitude: Number(item.latitude),
            longitude: Number(item.longitude),
            accuracy: item.accuracy == null ? null : Number(item.accuracy),
            recordedAt: item.recordedAt,
            recordingSessionId: item.recordingSessionId ?? null,
            recordingSessionName: item.recordingSessionName ?? null,
            sharedOwners: Array.isArray(item.sharedOwners)
                ? item.sharedOwners
                : [],
            batteryLevel:
                item.batteryLevel == null ? null : Number(item.batteryLevel),
        }))
        .filter(
            (item) =>
                item.recordingSessionId === recordingSessionId &&
                Number.isFinite(item.latitude) &&
                Number.isFinite(item.longitude),
        );
}

export type RecordingSessionBackfillProgress = {
    phase:
        | "loadingLocationLogs"
        | "processingSessions"
        | "recalculatingAggregates";

    loadedLocationLogCount: number;
    processedSessionCount: number;
    totalSessionCount: number;

    createdOrUpdatedCount: number;
    failedCount: number;

    currentRecordingSessionId?: string | null;
};

type RecordingSessionBackfillProgressCallback = (
    progress: RecordingSessionBackfillProgress,
) => void;

type RecordingSessionBackfillResult = {
    locationLogCount: number;
    targetSessionCount: number;
    createdOrUpdatedCount: number;
    failedCount: number;
    skippedLogCount: number;
    failures: {
        recordingSessionId: string;
        errorMessage: string;
    }[];
};

export async function backfillRecordingSessionsFromLocationLogs(
    onProgress?: RecordingSessionBackfillProgressCallback,
): Promise<RecordingSessionBackfillResult> {
    const currentUser = await getCurrentUser();
    const model = client.models.LocationLog as any;

    const allLogs: any[] = [];
    let nextToken: string | null = null;

    /*
     * まず、過去のLocationLogを全件取得する。
     * この時点では対象セッション総数が分からないため、
     * LocationLogの取得件数だけを通知する。
     */
    onProgress?.({
        phase: "loadingLocationLogs",
        loadedLocationLogCount: 0,
        processedSessionCount: 0,
        totalSessionCount: 0,
        createdOrUpdatedCount: 0,
        failedCount: 0,
        currentRecordingSessionId: null,
    });

    do {
        const result = (await model.list({
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(
                `LocationLog list failed: ${JSON.stringify(result.errors)}`,
            );
        }

        allLogs.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;

        onProgress?.({
            phase: "loadingLocationLogs",
            loadedLocationLogCount: allLogs.length,
            processedSessionCount: 0,
            totalSessionCount: 0,
            createdOrUpdatedCount: 0,
            failedCount: 0,
            currentRecordingSessionId: null,
        });
    } while (nextToken);

    const sessionMap = new Map<
        string,
        {
            recordingSessionName: string | null;
            sharedOwners: string[];
        }
    >();

    let skippedLogCount = 0;

    for (const log of allLogs) {
        if (log.userId !== currentUser.userId) {
            skippedLogCount += 1;
            continue;
        }

        const recordingSessionId =
            typeof log.recordingSessionId === "string"
                ? log.recordingSessionId.trim()
                : "";

        if (!recordingSessionId) {
            skippedLogCount += 1;
            continue;
        }

        const current = sessionMap.get(recordingSessionId);

        sessionMap.set(recordingSessionId, {
            recordingSessionName:
                current?.recordingSessionName ??
                log.recordingSessionName ??
                null,

            sharedOwners: Array.from(
                new Set([
                    ...(current?.sharedOwners ?? []),
                    ...(Array.isArray(log.sharedOwners)
                        ? log.sharedOwners.filter(
                              (owner: unknown): owner is string =>
                                  typeof owner === "string" && owner.length > 0,
                          )
                        : []),
                ]),
            ),
        });
    }

    const totalSessionCount = sessionMap.size;

    let processedSessionCount = 0;
    let createdOrUpdatedCount = 0;
    let failedCount = 0;

    const failures: RecordingSessionBackfillResult["failures"] = [];

    onProgress?.({
        phase: "processingSessions",
        loadedLocationLogCount: allLogs.length,
        processedSessionCount,
        totalSessionCount,
        createdOrUpdatedCount,
        failedCount,
        currentRecordingSessionId: null,
    });

    for (const [recordingSessionId, info] of sessionMap.entries()) {
        onProgress?.({
            phase: "processingSessions",
            loadedLocationLogCount: allLogs.length,
            processedSessionCount,
            totalSessionCount,
            createdOrUpdatedCount,
            failedCount,
            currentRecordingSessionId: recordingSessionId,
        });

        try {
            await upsertRecordingSessionSummary(
                recordingSessionId,
                info.recordingSessionName,
                info.sharedOwners,
                undefined,
                undefined,
                {
                    skipAggregation: true,
                },
            );

            createdOrUpdatedCount += 1;
        } catch (error) {
            failedCount += 1;

            failures.push({
                recordingSessionId,
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });

            console.error("[RecordingSessionBackfill] session failed:", {
                recordingSessionId,
                error,
            });
        } finally {
            processedSessionCount += 1;

            console.log(
                `[RecordingSessionBackfill] ${processedSessionCount} / ${totalSessionCount}`,
                {
                    recordingSessionId,
                    createdOrUpdatedCount,
                    failedCount,
                },
            );

            onProgress?.({
                phase: "processingSessions",
                loadedLocationLogCount: allLogs.length,
                processedSessionCount,
                totalSessionCount,
                createdOrUpdatedCount,
                failedCount,
                currentRecordingSessionId: recordingSessionId,
            });
        }
    }

    /*
     * 各セッション処理では集計をスキップしているため、
     * 最後に1回だけユーザー集計を再計算する。
     */
    onProgress?.({
        phase: "recalculatingAggregates",
        loadedLocationLogCount: allLogs.length,
        processedSessionCount,
        totalSessionCount,
        createdOrUpdatedCount,
        failedCount,
        currentRecordingSessionId: null,
    });

    await recalculateUserActivityAggregates(currentUser.userId);

    return {
        locationLogCount: allLogs.length,
        targetSessionCount: totalSessionCount,
        createdOrUpdatedCount,
        failedCount,
        skippedLogCount,
        failures,
    };
}
