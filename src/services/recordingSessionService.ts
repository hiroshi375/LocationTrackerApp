import { getCurrentUser } from "aws-amplify/auth";

import { client } from "../lib/client";
import {
    calculateRouteDistanceMeters,
    getRoutePeriod,
    normalizeRouteLogs,
} from "../lib/locationRoute";

type LocationLogListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

type RecordingSessionListResult = {
    data?: any[] | null;
    errors?: unknown;
};

type SessionLogItem = {
    id: string;
    userId: string;
    latitude: number;
    longitude: number;
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

    const startBatteryLevel = batteryLogs[0]?.batteryLevel ?? null;
    const endBatteryLevel =
        batteryLogs[batteryLogs.length - 1]?.batteryLevel ?? null;

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

    const recordingSessionModel = client.models.RecordingSession as any;

    const existingResult = (await recordingSessionModel.list({
        filter: {
            recordingSessionId: {
                eq: recordingSessionId,
            },
        },
        limit: 1,
    })) as RecordingSessionListResult;

    if (existingResult.errors) {
        console.error("RecordingSession list errors:", existingResult.errors);
        return;
    }

    const existing = existingResult.data?.[0];

    const existingSharedOwners = Array.isArray(existing?.sharedOwners)
        ? existing.sharedOwners.filter(
              (owner: unknown): owner is string =>
                  typeof owner === "string" && owner.length > 0,
          )
        : [];

    const explicitSharedOwners = shareOwnerValues.filter(
        (owner): owner is string =>
            typeof owner === "string" && owner.length > 0,
    );

    const sharedOwners = Array.from(
        new Set([
            ...existingSharedOwners,
            ...sharedOwnersFromLogs,
            ...explicitSharedOwners,
        ]),
    );

    const payload = {
        recordingSessionId,
        userId: currentUser.userId,
        recordingSessionName: summaryName,
        startedAt: startAt,
        endedAt: endAt,
        distanceMeters,
        pointCount: routeLogs.length,
        startBatteryLevel,
        endBatteryLevel,
        sharedOwners,
        recordingIntervalMs:
            typeof recordingIntervalMs === "number"
                ? recordingIntervalMs
                : (existing?.recordingIntervalMs ?? null),

        recordingDistanceMeters:
            typeof recordingDistanceMeters === "number"
                ? recordingDistanceMeters
                : (existing?.recordingDistanceMeters ?? null),
    };

    if (existing?.id) {
        const updateResult = await recordingSessionModel.update({
            id: existing.id,
            ...payload,
        });

        if (updateResult.errors) {
            console.error(
                "RecordingSession update errors:",
                updateResult.errors,
            );
        }

        return;
    }

    const createResult = await recordingSessionModel.create(payload);

    if (createResult.errors) {
        console.error("RecordingSession create errors:", createResult.errors);
    }
}

async function listLocationLogsBySessionId(recordingSessionId: string) {
    const allData: any[] = [];
    let nextToken: string | null = null;

    const locationLogModel = client.models.LocationLog as any;

    do {
        const listParams: {
            filter: {
                recordingSessionId: {
                    eq: string;
                };
            };
            limit: number;
            nextToken?: string;
        } = {
            filter: {
                recordingSessionId: {
                    eq: recordingSessionId,
                },
            },
            limit: 1000,
        };

        if (nextToken) {
            listParams.nextToken = nextToken;
        }

        const result = (await locationLogModel.list(
            listParams,
        )) as LocationLogListResult;

        if (result.errors) {
            console.error("LocationLog session list errors:", result.errors);
            return [];
        }

        allData.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    const logs: SessionLogItem[] = allData
        .map((item) => ({
            id: item.id,
            userId: item.userId ?? "",
            latitude: Number(item.latitude),
            longitude: Number(item.longitude),
            recordedAt: item.recordedAt,
            recordingSessionId: item.recordingSessionId ?? null,
            recordingSessionName: item.recordingSessionName ?? null,
            sharedOwners: Array.isArray(item.sharedOwners)
                ? item.sharedOwners
                : [],
            batteryLevel:
                item.batteryLevel !== null &&
                item.batteryLevel !== undefined &&
                Number.isFinite(Number(item.batteryLevel))
                    ? Number(item.batteryLevel)
                    : null,
        }))
        .filter(
            (item) =>
                item.recordingSessionId === recordingSessionId &&
                Number.isFinite(item.latitude) &&
                Number.isFinite(item.longitude),
        );

    return logs;
}

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

export async function backfillRecordingSessionsFromLocationLogs(): Promise<RecordingSessionBackfillResult> {
    const currentUser = await getCurrentUser();
    const locationLogModel = client.models.LocationLog as any;

    const allLogs: any[] = [];
    let nextToken: string | null = null;

    do {
        const result = (await locationLogModel.list({
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as LocationLogListResult;

        if (result.errors) {
            throw new Error(
                `LocationLog list failed: ${JSON.stringify(result.errors)}`,
            );
        }

        allLogs.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
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
        /*
         * 共有された他ユーザーのLocationLogを、
         * 現在ユーザーのRecordingSessionとして登録しない。
         */
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

        const currentSession = sessionMap.get(recordingSessionId);

        const sharedOwners = Array.isArray(log.sharedOwners)
            ? log.sharedOwners.filter(
                  (owner: unknown): owner is string =>
                      typeof owner === "string" && owner.length > 0,
              )
            : [];

        sessionMap.set(recordingSessionId, {
            recordingSessionName:
                currentSession?.recordingSessionName ??
                log.recordingSessionName ??
                null,

            sharedOwners: Array.from(
                new Set([
                    ...(currentSession?.sharedOwners ?? []),
                    ...sharedOwners,
                ]),
            ),
        });
    }

    let createdOrUpdatedCount = 0;
    let failedCount = 0;

    const failures: RecordingSessionBackfillResult["failures"] = [];

    for (const [recordingSessionId, sessionInfo] of sessionMap.entries()) {
        try {
            await upsertRecordingSessionSummary(
                recordingSessionId,
                sessionInfo.recordingSessionName,
                sessionInfo.sharedOwners,
            );

            createdOrUpdatedCount += 1;

            console.log("RecordingSession backfill success:", {
                recordingSessionId,
            });
        } catch (error) {
            failedCount += 1;

            const errorMessage =
                error instanceof Error ? error.message : String(error);

            failures.push({
                recordingSessionId,
                errorMessage,
            });

            console.error("RecordingSession backfill failed:", {
                recordingSessionId,
                error,
            });
        }
    }

    const result: RecordingSessionBackfillResult = {
        locationLogCount: allLogs.length,
        targetSessionCount: sessionMap.size,
        createdOrUpdatedCount,
        failedCount,
        skippedLogCount,
        failures,
    };

    console.log("RecordingSession backfill completed:", result);

    return result;
}
