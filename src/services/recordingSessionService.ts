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
};

export async function upsertRecordingSessionSummary(
    recordingSessionId: string,
    recordingSessionName?: string | null,
    liveShareOwnerValue?: string | null,
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

    const explicitSharedOwners = liveShareOwnerValue
        ? [liveShareOwnerValue]
        : [];

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
        sharedOwners,
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
        }))
        .filter(
            (item) =>
                item.recordingSessionId === recordingSessionId &&
                Number.isFinite(item.latitude) &&
                Number.isFinite(item.longitude),
        );

    return logs;
}
