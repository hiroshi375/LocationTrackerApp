import { client } from "../lib/client";
import { ensureUserProfile } from "./userProfileService";

type ListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

type MonthlyAggregate = {
    monthKey: string;
    distanceMeters: number;
    durationSeconds: number;
    sessionCount: number;
};

export function createMonthKey(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);

    if (!Number.isFinite(date.getTime())) {
        return "";
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");

    return `${year}-${month}`;
}

export async function recalculateUserActivityAggregates(
    userId: string,
): Promise<void> {
    let profile = await findUserProfile(userId);

    /*
     * ログインユーザー自身のUserProfileが存在しない場合は作成する。
     */
    if (!profile?.id) {
        console.warn(
            "UserProfile not found. Creating before activity aggregation.",
            {
                userId,
            },
        );

        await ensureUserProfile();
        profile = await findUserProfile(userId);
    }

    if (!profile?.id) {
        throw new Error(
            `集計対象のUserProfileを作成・取得できませんでした。userId: ${userId}`,
        );
    }

    const sessions = await listAllRecordingSessionsByUser(userId);
    const targetSessions = sessions.filter(
        (session) =>
            session?.userId === userId &&
            session?.isAggregationTarget === true &&
            Number.isFinite(Number(session?.distanceMeters)) &&
            session?.endedAt,
    );

    const monthlyMap = new Map<string, MonthlyAggregate>();

    let totalDistanceMeters = 0;
    let totalDurationSeconds = 0;

    for (const session of targetSessions) {
        const distanceMeters = Math.max(0, Number(session.distanceMeters ?? 0));
        const durationSeconds = getSessionDurationSeconds(session);
        const monthKey =
            typeof session.monthKey === "string" && session.monthKey
                ? session.monthKey
                : createMonthKey(session.endedAt);

        totalDistanceMeters += distanceMeters;
        totalDurationSeconds += durationSeconds;

        if (!monthKey) {
            continue;
        }

        const current = monthlyMap.get(monthKey) ?? {
            monthKey,
            distanceMeters: 0,
            durationSeconds: 0,
            sessionCount: 0,
        };

        current.distanceMeters += distanceMeters;
        current.durationSeconds += durationSeconds;
        current.sessionCount += 1;

        monthlyMap.set(monthKey, current);
    }

    const currentMonthKey = createMonthKey(new Date());
    const currentMonth = monthlyMap.get(currentMonthKey) ?? {
        monthKey: currentMonthKey,
        distanceMeters: 0,
        durationSeconds: 0,
        sessionCount: 0,
    };

    const profileUpdateResult = await client.models.UserProfile.update({
        id: profile.id,
        totalAggregationDistanceMeters: roundNumber(totalDistanceMeters, 2),
        totalAggregationDurationSeconds: Math.round(totalDurationSeconds),
        totalAggregationSessionCount: targetSessions.length,
        currentMonthKey,
        currentMonthDistanceMeters: roundNumber(currentMonth.distanceMeters, 2),
        currentMonthDurationSeconds: Math.round(currentMonth.durationSeconds),
        currentMonthSessionCount: currentMonth.sessionCount,
    });

    if (profileUpdateResult.errors) {
        throw new Error(
            `UserProfile aggregate update failed: ${JSON.stringify(
                profileUpdateResult.errors,
            )}`,
        );
    }

    await synchronizeMonthlySummaries(userId, profile, monthlyMap);
}

async function listAllRecordingSessionsByUser(userId: string): Promise<any[]> {
    const model = client.models.RecordingSession as any;
    const allData: any[] = [];
    let nextToken: string | null = null;

    do {
        const result = (await model.listRecordingSessionsByUserAndEndedAt({
            userId,
            sortDirection: "DESC",
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(
                `RecordingSession aggregate list failed: ${JSON.stringify(
                    result.errors,
                )}`,
            );
        }

        allData.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    return allData;
}

async function findUserProfile(userId: string): Promise<any | null> {
    const model = client.models.UserProfile as any;

    let nextToken: string | null = null;

    do {
        const result = (await model.list({
            filter: {
                userId: {
                    eq: userId,
                },
            },
            limit: 100,
            nextToken: nextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(
                `UserProfile list failed: ${JSON.stringify(result.errors)}`,
            );
        }

        const profile = (result.data ?? []).find(
            (item: any) => item?.id && item.userId === userId,
        );

        if (profile) {
            console.log("[ActivityAggregation] UserProfile found:", {
                requestedUserId: userId,
                profileId: profile.id,
                profileUserId: profile.userId,
            });

            return profile;
        }

        nextToken = result.nextToken ?? null;
    } while (nextToken);

    console.warn("[ActivityAggregation] UserProfile not found after paging:", {
        userId,
    });

    return null;
}

async function synchronizeMonthlySummaries(
    userId: string,
    profile: any,
    monthlyMap: Map<string, MonthlyAggregate>,
): Promise<void> {
    const model = client.models.UserActivityMonthlySummary as any;
    const existingSummaries = await listMonthlySummariesByUser(userId);
    const existingMap = new Map<string, any>();

    existingSummaries.forEach((summary) => {
        if (typeof summary?.monthKey === "string") {
            existingMap.set(summary.monthKey, summary);
        }
    });

    for (const aggregate of monthlyMap.values()) {
        const existing = existingMap.get(aggregate.monthKey);

        const payload = {
            userId,
            monthKey: aggregate.monthKey,
            distanceMeters: roundNumber(aggregate.distanceMeters, 2),
            durationSeconds: Math.round(aggregate.durationSeconds),
            sessionCount: aggregate.sessionCount,
            displayName: profile.displayName ?? profile.email ?? "ユーザー",
            iconImagePath: profile.iconImagePath ?? null,
        };

        const result = existing?.id
            ? await model.update({
                  id: existing.id,
                  ...payload,
              })
            : await model.create({
                  id: createMonthlySummaryId(userId, aggregate.monthKey),
                  ...payload,
              });

        if (result.errors) {
            throw new Error(
                `Monthly summary upsert failed: ${JSON.stringify(
                    result.errors,
                )}`,
            );
        }

        existingMap.delete(aggregate.monthKey);
    }

    for (const staleSummary of existingMap.values()) {
        if (!staleSummary?.id) {
            continue;
        }

        const result = await model.delete({
            id: staleSummary.id,
        });

        if (result.errors) {
            throw new Error(
                `Monthly summary delete failed: ${JSON.stringify(
                    result.errors,
                )}`,
            );
        }
    }
}

async function listMonthlySummariesByUser(userId: string): Promise<any[]> {
    const model = client.models.UserActivityMonthlySummary as any;
    const allData: any[] = [];
    let nextToken: string | null = null;

    do {
        const result = (await model.listMonthlyActivitySummariesByUser({
            userId,
            sortDirection: "DESC",
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(
                `Monthly summary list failed: ${JSON.stringify(result.errors)}`,
            );
        }

        allData.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    return allData;
}

function getSessionDurationSeconds(session: any): number {
    if (
        Number.isFinite(Number(session?.movingDurationSeconds)) &&
        Number(session.movingDurationSeconds) >= 0
    ) {
        return Number(session.movingDurationSeconds);
    }

    const startedAt = new Date(session?.startedAt ?? 0).getTime();
    const endedAt = new Date(session?.endedAt ?? 0).getTime();

    if (
        !Number.isFinite(startedAt) ||
        !Number.isFinite(endedAt) ||
        endedAt <= startedAt
    ) {
        return 0;
    }

    return Math.round((endedAt - startedAt) / 1000);
}

function createMonthlySummaryId(userId: string, monthKey: string): string {
    return `activity-month#${userId}#${monthKey}`;
}

function roundNumber(value: number, digits: number): number {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}
