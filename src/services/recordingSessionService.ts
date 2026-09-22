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

    /*
     * AUTO再評価時に、
     * 既存区分と新しい判定結果を比較するため保持する。
     */
    activityType?: string | null;
    isAggregationTarget?: boolean | null;
};

type RecordingSessionSummaryOptions = {
    skipAggregation?: boolean;
    /*
     * Backfill等で複数sessionを一括処理するときは
     * 各sessionごとの課金利用量再計算をスキップする。
     */
    skipSubscriptionUsageRecalculation?: boolean;
    lastContinuationConfirmedAt?: string | null;
    continuationConfirmationCount?: number | null;
    autoStoppedAt?: string | null;
    autoStopReason?: string | null;
};

function createRecordingSessionRecordId(
    userId: string,
    recordingSessionId: string,
): string {
    return `recording-session:${userId}:${recordingSessionId}`;
}

export async function recalculateCurrentMonthRecordedActivityUsage(
    userId: string,
    now = new Date(),
): Promise<number> {
    const recordingSessionModel = client.models.RecordingSession as any;

    const userProfileModel = client.models.UserProfile as any;

    const currentMonthKey = createMonthKey(now.toISOString());

    /*
     * ローカルタイム基準で今月の範囲を作る。
     */
    const startOfMonth = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
        0,
        0,
        0,
        0,
    );

    const startOfNextMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        1,
        0,
        0,
        0,
        0,
    );

    const endOfMonth = new Date(startOfNextMonth.getTime() - 1);

    let nextToken: string | null = null;
    let count = 0;

    do {
        const result =
            (await recordingSessionModel.listRecordingSessionsByUserAndEndedAt({
                userId,

                endedAt: {
                    between: [
                        startOfMonth.toISOString(),
                        endOfMonth.toISOString(),
                    ],
                },

                sortDirection: "ASC",
                limit: 1000,
                nextToken: nextToken ?? undefined,
            })) as ListResult;

        if (result.errors) {
            throw new Error(
                `RecordingSession monthly usage query failed: ${JSON.stringify(
                    result.errors,
                )}`,
            );
        }

        count += (result.data ?? []).filter(
            (item: any) =>
                item?.userId === userId &&
                typeof item.recordingSessionId === "string" &&
                item.recordingSessionId.length > 0,
        ).length;

        nextToken = result.nextToken ?? null;
    } while (nextToken);

    /*
     * UserProfileは現在id=userIdで作成しているため、
     * 固定IDで直接更新する。
     */
    const profileResult = await userProfileModel.listUserProfilesByUserId({
        userId,
        limit: 10,
    });

    if (profileResult.errors) {
        throw new Error(
            `UserProfile subscription usage query failed: ${JSON.stringify(
                profileResult.errors,
            )}`,
        );
    }

    const profile = (profileResult.data ?? []).find(
        (item: any) =>
            item?.userId === userId &&
            typeof item.id === "string" &&
            item.id.length > 0,
    );

    if (!profile?.id) {
        throw new Error(
            `UserProfile not found for subscription usage: ${userId}`,
        );
    }

    const updateResult = await userProfileModel.update({
        id: userId,
        subscriptionUsageMonthKey: currentMonthKey,
        currentMonthRecordedActivityCount: count,
    });

    if (updateResult.errors) {
        throw new Error(
            `UserProfile subscription usage update failed: ${JSON.stringify(
                updateResult.errors,
            )}`,
        );
    }

    console.log(
        "[SubscriptionUsage] Current month activity usage recalculated:",
        {
            userId,
            currentMonthKey,
            count,
        },
    );

    return count;
}

export async function upsertRecordingSessionSummary(
    recordingSessionId: string,
    recordingSessionName: string | null,
    shareOwnerValues: string[] = [],
    recordingIntervalMs?: number | null,
    recordingDistanceMeters?: number | null,
    options?: RecordingSessionSummaryOptions,
) {
    const logs = await listLocationLogsBySessionId(recordingSessionId);
    const routeLogs = normalizeRouteLogs(logs);

    console.log("[RecordingSessionSummary] LocationLog counts:", {
        recordingSessionId,
        locationLogCount: logs.length,
        routeLogCount: routeLogs.length,
    });

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
        "自動記録アクティビティ";

    const model = client.models.RecordingSession as any;

    const recordingSessionRecordId = createRecordingSessionRecordId(
        currentUser.userId,
        recordingSessionId,
    );

    const existingResult = (await model.list({
        filter: {
            and: [
                {
                    recordingSessionId: {
                        eq: recordingSessionId,
                    },
                },
                {
                    userId: {
                        eq: currentUser.userId,
                    },
                },
            ],
        },
        limit: 1000,
    })) as ListResult;

    if (existingResult.errors) {
        throw new Error(
            `RecordingSession list failed: ${JSON.stringify(
                existingResult.errors,
            )}`,
        );
    }

    const existingSessions = (existingResult.data ?? []).filter(
        (session: any) =>
            session?.id &&
            session.recordingSessionId === recordingSessionId &&
            session.userId === currentUser.userId,
    );

    /*
     * 固定IDのレコードを優先する。
     * 過去レコードが自動採番IDの場合は、最初の1件を更新対象として残す。
     */
    const existing =
        existingSessions.find(
            (session: any) => session.id === recordingSessionRecordId,
        ) ??
        existingSessions[0] ??
        null;
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
        pointCount: logs.length,
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
        lastContinuationConfirmedAt:
            options?.lastContinuationConfirmedAt !== undefined
                ? options.lastContinuationConfirmedAt
                : (existing?.lastContinuationConfirmedAt ?? null),

        continuationConfirmationCount:
            options?.continuationConfirmationCount !== undefined
                ? options.continuationConfirmationCount
                : (existing?.continuationConfirmationCount ?? 0),

        autoStoppedAt:
            options?.autoStoppedAt !== undefined
                ? options.autoStoppedAt
                : (existing?.autoStoppedAt ?? null),

        autoStopReason:
            options?.autoStopReason !== undefined
                ? options.autoStopReason
                : (existing?.autoStopReason ?? null),
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

    let saveResult: {
        data?: any;
        errors?: unknown;
    };

    if (existing?.id) {
        saveResult = await model.update({
            id: existing.id,
            ...payload,
        });
    } else {
        saveResult = await model.create({
            id: recordingSessionRecordId,
            ...payload,
        });
    }

    if (saveResult.errors) {
        /*
         * 並行処理などで固定IDが直前に作成された場合は、
         * 固定IDのレコードを更新して再試行する。
         */
        if (!existing?.id) {
            const retryResult = await model.update({
                id: recordingSessionRecordId,
                ...payload,
            });

            if (retryResult.errors) {
                throw new Error(
                    `RecordingSession save failed: ${JSON.stringify(
                        retryResult.errors,
                    )}`,
                );
            }
        } else {
            throw new Error(
                `RecordingSession save failed: ${JSON.stringify(
                    saveResult.errors,
                )}`,
            );
        }
    }

    /*
     * 同じユーザー・同じrecordingSessionIdで複数存在する
     * RecordingSessionを整理する。
     */
    const savedRecordId = existing?.id ?? recordingSessionRecordId;

    const duplicateSessions = existingSessions.filter(
        (session: any) => session.id !== savedRecordId,
    );

    for (const duplicateSession of duplicateSessions) {
        const deleteResult = await model.delete({
            id: duplicateSession.id,
        });

        if (deleteResult.errors) {
            console.error("Duplicate RecordingSession delete errors:", {
                recordingSessionId,
                duplicateId: duplicateSession.id,
                errors: deleteResult.errors,
            });
        }
    }

    await updateLocationLogClassification(
        logs,
        activityType,
        isAggregationTarget,
    );

    /*
     * 課金制限用の月間アクティビティ件数を更新する。
     *
     * RecordingSessionを正本として毎回再計算するため、
     * 同一sessionの再保存でも二重加算されない。
     *
     * Backfillなど複数sessionを一括処理するときは、
     * skipSubscriptionUsageRecalculation = true として
     * 各sessionごとの再計算をスキップする。
     */
    if (!options?.skipSubscriptionUsageRecalculation) {
        await recalculateCurrentMonthRecordedActivityUsage(currentUser.userId);
    }

    /*
     * 既存のアクティビティ集計処理。
     *
     * Backfillでは各sessionごとの集計をスキップし、
     * 最後にまとめて再計算する。
     */
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

    const normalizedRecordingSessionId = recordingSessionId.trim();

    if (!normalizedRecordingSessionId) {
        throw new Error("recordingSessionIdが空です。");
    }

    const deterministicId = createRecordingSessionRecordId(
        currentUser.userId,
        normalizedRecordingSessionId,
    );

    /*
     * 新しい固定ID形式のレコードを最初に直接取得する。
     */
    const getResult = await model.get({
        id: deterministicId,
    });

    if (getResult.errors) {
        console.warn(
            "RecordingSession deterministic ID get errors:",
            getResult.errors,
        );
    }

    let session = getResult.data ?? null;

    /*
     * 過去に自動採番IDで作られたRecordingSessionとの互換性を保つ。
     */
    if (!session) {
        const listResult = (await model.list({
            filter: {
                and: [
                    {
                        recordingSessionId: {
                            eq: normalizedRecordingSessionId,
                        },
                    },
                    {
                        userId: {
                            eq: currentUser.userId,
                        },
                    },
                ],
            },
            limit: 1000,
        })) as ListResult;

        if (listResult.errors) {
            console.error("RecordingSession activity type list errors:", {
                recordingSessionId: normalizedRecordingSessionId,
                userId: currentUser.userId,
                errors: listResult.errors,
            });

            throw new Error(
                `RecordingSessionの検索に失敗しました: ${JSON.stringify(
                    listResult.errors,
                )}`,
            );
        }

        const matchingSessions = (listResult.data ?? []).filter(
            (item: any) =>
                item?.id &&
                item.recordingSessionId === normalizedRecordingSessionId &&
                item.userId === currentUser.userId,
        );

        session = matchingSessions[0] ?? null;
    }

    if (!session?.id) {
        console.error("RecordingSession not found for activity update:", {
            recordingSessionId: normalizedRecordingSessionId,
            deterministicId,
            userId: currentUser.userId,
        });

        throw new Error(
            `対象のRecordingSessionを取得できませんでした。セッションID: ${normalizedRecordingSessionId}`,
        );
    }

    if (session.userId !== currentUser.userId) {
        throw new Error("自分以外のアクティビティ区分は変更できません。");
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
        console.error("RecordingSession activity type update errors:", {
            id: session.id,
            recordingSessionId: normalizedRecordingSessionId,
            errors: updateResult.errors,
        });

        throw new Error(
            `RecordingSessionの区分更新に失敗しました: ${JSON.stringify(
                updateResult.errors,
            )}`,
        );
    }

    const logs = await listLocationLogsBySessionId(
        normalizedRecordingSessionId,
    );

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

export async function recalculateCurrentUserSubscriptionUsage(): Promise<number> {
    const currentUser = await getCurrentUser();

    return recalculateCurrentMonthRecordedActivityUsage(currentUser.userId);
}

export type AutoActivityReclassificationProgress = {
    phase:
        | "loadingRecordingSessions"
        | "loadingLocationLogs"
        | "reclassifyingSessions"
        | "recalculatingAggregates";

    loadedRecordingSessionCount: number;
    loadedLocationLogCount: number;

    processedSessionCount: number;
    totalSessionCount: number;

    changedSessionCount: number;
    unchangedSessionCount: number;

    updatedLocationLogCount: number;
    skippedUnchangedLocationLogCount: number;

    failedCount: number;

    currentRecordingSessionId?: string | null;
    currentRecordingSessionName?: string | null;
};

type AutoActivityReclassificationProgressCallback = (
    progress: AutoActivityReclassificationProgress,
) => void;

export type AutoActivityReclassificationResult = {
    locationLogCount: number;
    targetSessionCount: number;
    reclassifiedCount: number;
    changedSessionCount: number;
    unchangedSessionCount: number;

    /*
     * 実際にDynamoDB updateしたLocationLog数。
     */
    updatedLocationLogCount: number;

    /*
     * 新しい区分と既存区分が同じだったため
     * updateを省略したLocationLog数。
     */
    skippedUnchangedLocationLogCount: number;

    failedCount: number;

    failures: {
        recordingSessionId: string;
        errorMessage: string;
    }[];
};

export async function reclassifyCurrentUserAutoActivitySessions(
    onProgress?: AutoActivityReclassificationProgressCallback,
): Promise<AutoActivityReclassificationResult> {
    const currentUser = await getCurrentUser();

    const recordingSessionModel = client.models.RecordingSession as any;

    const locationLogModel = client.models.LocationLog as any;

    /*
     * ------------------------------------------------------------
     * 1. 現在ユーザーのRecordingSessionを最初に取得する。
     * ------------------------------------------------------------
     *
     * AUTOだけを対象にするが、
     * 同じrecordingSessionIdにMANUALレコードが存在する場合は
     * ユーザーの手動設定を最優先し、対象外にする。
     */
    const allRecordingSessions: any[] = [];

    let recordingSessionNextToken: string | null = null;

    onProgress?.({
        phase: "loadingRecordingSessions",
        loadedRecordingSessionCount: 0,
        loadedLocationLogCount: 0,
        processedSessionCount: 0,
        totalSessionCount: 0,
        changedSessionCount: 0,
        unchangedSessionCount: 0,
        updatedLocationLogCount: 0,
        skippedUnchangedLocationLogCount: 0,
        failedCount: 0,
        currentRecordingSessionId: null,
        currentRecordingSessionName: null,
    });

    do {
        const result = (await recordingSessionModel.list({
            filter: {
                userId: {
                    eq: currentUser.userId,
                },
            },
            limit: 1000,
            nextToken: recordingSessionNextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(
                `RecordingSession list failed: ${JSON.stringify(
                    result.errors,
                )}`,
            );
        }

        allRecordingSessions.push(...(result.data ?? []));

        recordingSessionNextToken = result.nextToken ?? null;

        onProgress?.({
            phase: "loadingRecordingSessions",
            loadedRecordingSessionCount: allRecordingSessions.length,
            loadedLocationLogCount: 0,
            processedSessionCount: 0,
            totalSessionCount: 0,
            changedSessionCount: 0,
            unchangedSessionCount: 0,
            updatedLocationLogCount: 0,
            skippedUnchangedLocationLogCount: 0,
            failedCount: 0,
            currentRecordingSessionId: null,
            currentRecordingSessionName: null,
        });
    } while (recordingSessionNextToken);

    /*
     * recordingSessionIdごとにまとめる。
     */
    const recordingSessionGroups = new Map<string, any[]>();

    for (const session of allRecordingSessions) {
        if (session?.userId !== currentUser.userId) {
            continue;
        }

        const recordingSessionId =
            typeof session.recordingSessionId === "string"
                ? session.recordingSessionId.trim()
                : "";

        if (!recordingSessionId) {
            continue;
        }

        const sessions = recordingSessionGroups.get(recordingSessionId) ?? [];

        sessions.push(session);

        recordingSessionGroups.set(recordingSessionId, sessions);
    }

    /*
     * AUTO対象セッションを作る。
     *
     * MANUALが1件でも存在するrecordingSessionIdは、
     * 手動設定を守るため再評価対象にしない。
     */
    const targetSessionMap = new Map<string, any>();

    for (const [
        recordingSessionId,
        sessions,
    ] of recordingSessionGroups.entries()) {
        const hasManualClassification = sessions.some(
            (session) => session.classificationSource === "MANUAL",
        );

        if (hasManualClassification) {
            continue;
        }

        const autoSessions = sessions.filter(
            (session) => session.classificationSource === "AUTO",
        );

        if (autoSessions.length === 0) {
            continue;
        }

        /*
         * 固定ID形式のRecordingSessionを優先する。
         */
        const deterministicId = createRecordingSessionRecordId(
            currentUser.userId,
            recordingSessionId,
        );

        const targetSession =
            autoSessions.find((session) => session.id === deterministicId) ??
            autoSessions[0];

        targetSessionMap.set(recordingSessionId, targetSession);
    }

    console.log("[ActivityReclassification] target sessions:", {
        recordingSessionCount: allRecordingSessions.length,
        targetSessionCount: targetSessionMap.size,
    });

    onProgress?.({
        phase: "loadingLocationLogs",
        loadedRecordingSessionCount: allRecordingSessions.length,
        loadedLocationLogCount: 0,
        processedSessionCount: 0,
        totalSessionCount: targetSessionMap.size,
        changedSessionCount: 0,
        unchangedSessionCount: 0,
        updatedLocationLogCount: 0,
        skippedUnchangedLocationLogCount: 0,
        failedCount: 0,
        currentRecordingSessionId: null,
        currentRecordingSessionName: null,
    });

    /*
     * ------------------------------------------------------------
     * 2. LocationLogを1回だけ全件走査する。
     * ------------------------------------------------------------
     *
     * セッションごとにmodel.list()しない。
     *
     * 33,920件なら、おおむね1000件 × 約34ページの
     * DynamoDB/AppSync取得だけで済む。
     */
    const sessionMap = new Map<string, SessionLogItem[]>();

    let locationLogNextToken: string | null = null;

    let locationLogCount = 0;

    do {
        const result = (await locationLogModel.list({
            limit: 1000,
            nextToken: locationLogNextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(
                `LocationLog list failed: ${JSON.stringify(result.errors)}`,
            );
        }

        const pageLogs = result.data ?? [];

        locationLogCount += pageLogs.length;

        for (const rawLog of pageLogs) {
            /*
             * 他ユーザーのLocationLogは除外する。
             */
            if (rawLog?.userId !== currentUser.userId) {
                continue;
            }

            const recordingSessionId =
                typeof rawLog.recordingSessionId === "string"
                    ? rawLog.recordingSessionId.trim()
                    : "";

            if (!recordingSessionId) {
                continue;
            }

            /*
             * AUTO再評価対象でないセッションは
             * Mapへ保持しない。
             *
             * これにより33,920件すべてを
             * メモリに保持する必要がない。
             */
            if (!targetSessionMap.has(recordingSessionId)) {
                continue;
            }

            const latitude = Number(rawLog.latitude);

            const longitude = Number(rawLog.longitude);

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                continue;
            }

            const log: SessionLogItem = {
                id: rawLog.id,
                userId: rawLog.userId ?? "",
                latitude,
                longitude,
                accuracy:
                    rawLog.accuracy == null ? null : Number(rawLog.accuracy),
                recordedAt: rawLog.recordedAt,
                recordingSessionId,
                recordingSessionName: rawLog.recordingSessionName ?? null,
                sharedOwners: Array.isArray(rawLog.sharedOwners)
                    ? rawLog.sharedOwners
                    : [],
                batteryLevel:
                    rawLog.batteryLevel == null
                        ? null
                        : Number(rawLog.batteryLevel),

                activityType:
                    typeof rawLog.activityType === "string"
                        ? rawLog.activityType
                        : null,

                isAggregationTarget:
                    typeof rawLog.isAggregationTarget === "boolean"
                        ? rawLog.isAggregationTarget
                        : null,
            };

            const sessionLogs = sessionMap.get(recordingSessionId) ?? [];

            sessionLogs.push(log);

            sessionMap.set(recordingSessionId, sessionLogs);
        }

        locationLogNextToken = result.nextToken ?? null;

        onProgress?.({
            phase: "loadingLocationLogs",
            loadedRecordingSessionCount: allRecordingSessions.length,
            loadedLocationLogCount: locationLogCount,
            processedSessionCount: 0,
            totalSessionCount: targetSessionMap.size,
            changedSessionCount: 0,
            unchangedSessionCount: 0,
            updatedLocationLogCount: 0,
            skippedUnchangedLocationLogCount: 0,
            failedCount: 0,
            currentRecordingSessionId: null,
            currentRecordingSessionName: null,
        });

        console.log("[ActivityReclassification] LocationLog loading:", {
            locationLogCount,
            targetSessionLogGroups: sessionMap.size,
        });
    } while (locationLogNextToken);

    /*
     * ------------------------------------------------------------
     * 3. 各AUTOセッションをメモリ上のLocationLogで再評価する。
     * ------------------------------------------------------------
     */
    let processedSessionCount = 0;
    let reclassifiedCount = 0;
    let changedSessionCount = 0;
    let unchangedSessionCount = 0;

    let updatedLocationLogCount = 0;

    let skippedUnchangedLocationLogCount = 0;

    let failedCount = 0;

    const failures: AutoActivityReclassificationResult["failures"] = [];

    onProgress?.({
        phase: "reclassifyingSessions",
        loadedRecordingSessionCount: allRecordingSessions.length,
        loadedLocationLogCount: locationLogCount,
        processedSessionCount: 0,
        totalSessionCount: targetSessionMap.size,
        changedSessionCount,
        unchangedSessionCount,
        updatedLocationLogCount,
        skippedUnchangedLocationLogCount,
        failedCount,
        currentRecordingSessionId: null,
        currentRecordingSessionName: null,
    });

    for (const [recordingSessionId, session] of targetSessionMap.entries()) {
        onProgress?.({
            phase: "reclassifyingSessions",
            loadedRecordingSessionCount: allRecordingSessions.length,
            loadedLocationLogCount: locationLogCount,
            processedSessionCount,
            totalSessionCount: targetSessionMap.size,
            changedSessionCount,
            unchangedSessionCount,
            updatedLocationLogCount,
            skippedUnchangedLocationLogCount,
            failedCount,
            currentRecordingSessionId: recordingSessionId,
            currentRecordingSessionName: session.recordingSessionName ?? null,
        });

        try {
            const logs = sessionMap.get(recordingSessionId) ?? [];

            if (logs.length === 0) {
                throw new Error("対象のLocationLogがありません。");
            }

            /*
             * 最新の判定ロジックで再評価する。
             */
            const classification = classifyActivitySession(logs);

            const previousActivityType =
                typeof session.activityType === "string"
                    ? normalizeActivityType(session.activityType)
                    : null;

            const activityTypeChanged =
                previousActivityType !== classification.activityType;

            const aggregationTargetChanged =
                typeof session.isAggregationTarget !== "boolean" ||
                session.isAggregationTarget !==
                    classification.isAggregationTarget;

            if (activityTypeChanged || aggregationTargetChanged) {
                changedSessionCount += 1;
            } else {
                unchangedSessionCount += 1;
            }

            /*
             * RecordingSessionは更新する。
             *
             * activityTypeが同じ場合でも、
             * classificationReason / averageSpeed /
             * maxSpeed / movingDurationSeconds は
             * 新しい判定ロジックの結果へ更新する。
             */
            const updateSessionResult = await recordingSessionModel.update({
                id: session.id,

                activityType: classification.activityType,

                isAggregationTarget: classification.isAggregationTarget,

                classificationSource: "AUTO",

                classificationReason: classification.classificationReason,

                averageSpeedKmh: classification.averageSpeedKmh,

                maxSpeedKmh: classification.maxSpeedKmh,

                movingDurationSeconds: classification.movingDurationSeconds,
            });

            if (updateSessionResult.errors) {
                throw new Error(
                    `RecordingSession classification update failed: ${JSON.stringify(
                        updateSessionResult.errors,
                    )}`,
                );
            }

            /*
             * ----------------------------------------------------
             * 4. LocationLogは区分が変わったものだけupdateする。
             * ----------------------------------------------------
             */
            const changedLogs = logs.filter((log) => {
                const existingActivityType =
                    typeof log.activityType === "string"
                        ? normalizeActivityType(log.activityType)
                        : null;

                const activityChanged =
                    existingActivityType !== classification.activityType;

                const aggregationChanged =
                    typeof log.isAggregationTarget !== "boolean" ||
                    log.isAggregationTarget !==
                        classification.isAggregationTarget;

                return activityChanged || aggregationChanged;
            });

            const unchangedLogCount = logs.length - changedLogs.length;

            skippedUnchangedLocationLogCount += unchangedLogCount;

            /*
             * DynamoDB/AppSyncへの同時リクエスト数を
             * 抑えるため25件単位で更新する。
             */
            for (let index = 0; index < changedLogs.length; index += 25) {
                const batch = changedLogs.slice(index, index + 25);

                const results = await Promise.all(
                    batch.map((log) =>
                        locationLogModel.update({
                            id: log.id,

                            activityType: classification.activityType,

                            isAggregationTarget:
                                classification.isAggregationTarget,
                        }),
                    ),
                );

                if (results.some((result) => result.errors)) {
                    throw new Error("LocationLogの区分更新に失敗しました。");
                }

                updatedLocationLogCount += batch.length;
            }

            reclassifiedCount += 1;

            console.log("[ActivityReclassification] completed:", {
                recordingSessionId,
                previousActivityType,
                newActivityType: classification.activityType,
                sessionChanged: activityTypeChanged || aggregationTargetChanged,
                locationLogCount: logs.length,
                updatedLocationLogCount: changedLogs.length,
                skippedLocationLogCount: unchangedLogCount,
                reclassifiedCount,
                targetSessionCount: targetSessionMap.size,
            });
        } catch (error) {
            failedCount += 1;

            const errorMessage =
                error instanceof Error ? error.message : String(error);

            failures.push({
                recordingSessionId,
                errorMessage,
            });

            console.error("[ActivityReclassification] failed:", {
                recordingSessionId,
                error,
            });
        } finally {
            /*
             * 成功・失敗にかかわらず
             * 1セッション処理完了として進める。
             */
            processedSessionCount += 1;

            onProgress?.({
                phase: "reclassifyingSessions",
                loadedRecordingSessionCount: allRecordingSessions.length,
                loadedLocationLogCount: locationLogCount,
                processedSessionCount,
                totalSessionCount: targetSessionMap.size,
                changedSessionCount,
                unchangedSessionCount,
                updatedLocationLogCount,
                skippedUnchangedLocationLogCount,
                failedCount,
                currentRecordingSessionId: recordingSessionId,
                currentRecordingSessionName:
                    session.recordingSessionName ?? null,
            });
        }
    }

    /*
     * ------------------------------------------------------------
     * 5. 集計は最後に1回だけ再計算する。
     * ------------------------------------------------------------
     */
    onProgress?.({
        phase: "recalculatingAggregates",
        loadedRecordingSessionCount: allRecordingSessions.length,
        loadedLocationLogCount: locationLogCount,
        processedSessionCount,
        totalSessionCount: targetSessionMap.size,
        changedSessionCount,
        unchangedSessionCount,
        updatedLocationLogCount,
        skippedUnchangedLocationLogCount,
        failedCount,
        currentRecordingSessionId: null,
        currentRecordingSessionName: null,
    });

    await recalculateCurrentMonthRecordedActivityUsage(currentUser.userId);

    await recalculateUserActivityAggregates(currentUser.userId);

    console.log("[ActivityReclassification] finished:", {
        locationLogCount,
        targetSessionCount: targetSessionMap.size,
        reclassifiedCount,
        changedSessionCount,
        unchangedSessionCount,
        updatedLocationLogCount,
        skippedUnchangedLocationLogCount,
        failedCount,
    });

    return {
        locationLogCount,
        targetSessionCount: targetSessionMap.size,
        reclassifiedCount,
        changedSessionCount,
        unchangedSessionCount,
        updatedLocationLogCount,
        skippedUnchangedLocationLogCount,
        failedCount,
        failures,
    };
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
            activityType:
                typeof item.activityType === "string"
                    ? item.activityType
                    : null,

            isAggregationTarget:
                typeof item.isAggregationTarget === "boolean"
                    ? item.isAggregationTarget
                    : null,
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
                    skipSubscriptionUsageRecalculation: true,
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

    await recalculateCurrentMonthRecordedActivityUsage(currentUser.userId);
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
