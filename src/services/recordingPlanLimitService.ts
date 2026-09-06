import AsyncStorage from "@react-native-async-storage/async-storage";

import {
    getSubscriptionPlanLimits,
    type SubscriptionTier,
} from "../config/subscriptionPlan";

const RECORDING_PLAN_LIMIT_STATE_KEY =
    "location-tracker-recording-plan-limit-state";

export type RecordingPlanLimitReason = "DURATION" | "POINTS";

export type RecordingPlanLimitState = {
    recordingSessionId: string;
    subscriptionTier: SubscriptionTier;

    recordingStartedAt: string;

    maxActivityDurationMs: number | null;
    maxPointsPerActivity: number | null;

    /*
     * LocationLogとして保存することを確保済みの
     * 決定的LocationLog ID。
     *
     * timeout時は、実際にはCloud保存済みの可能性があるため
     * reservationを残す。
     */
    reservedLocationLogIds: string[];

    limitReachedReason: RecordingPlanLimitReason | null;
    limitReachedAt: string | null;
};

export type RecordingPlanPointReservationResult = {
    allowed: boolean;
    state: RecordingPlanLimitState | null;

    reason: RecordingPlanLimitReason | null;

    /*
     * trueの場合、このLocationLog IDは以前に予約済み。
     * timeout後のretryやduplicate確認時に使用する。
     */
    alreadyReserved: boolean;

    /*
     * 今回の予約によって1000件へ到達した場合true。
     */
    reachedByThisReservation: boolean;
};

export async function initializeRecordingPlanLimitState(
    recordingSessionId: string,
    recordingStartedAt: string,
    subscriptionTier: SubscriptionTier,
): Promise<RecordingPlanLimitState> {
    const limits = getSubscriptionPlanLimits(subscriptionTier);

    const state: RecordingPlanLimitState = {
        recordingSessionId,
        subscriptionTier,

        recordingStartedAt,

        maxActivityDurationMs: limits.maxActivityDurationMs,

        maxPointsPerActivity: limits.maxPointsPerActivity,

        reservedLocationLogIds: [],

        limitReachedReason: null,
        limitReachedAt: null,
    };

    await writeRecordingPlanLimitState(state);

    return state;
}

export async function getRecordingPlanLimitState(): Promise<RecordingPlanLimitState | null> {
    const raw = await AsyncStorage.getItem(RECORDING_PLAN_LIMIT_STATE_KEY);

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<RecordingPlanLimitState>;

        if (
            typeof parsed.recordingSessionId !== "string" ||
            !parsed.recordingSessionId ||
            typeof parsed.recordingStartedAt !== "string" ||
            !parsed.recordingStartedAt
        ) {
            return null;
        }

        return {
            recordingSessionId: parsed.recordingSessionId,

            subscriptionTier:
                parsed.subscriptionTier === "PREMIUM" ? "PREMIUM" : "FREE",

            recordingStartedAt: parsed.recordingStartedAt,

            maxActivityDurationMs:
                typeof parsed.maxActivityDurationMs === "number"
                    ? parsed.maxActivityDurationMs
                    : null,

            maxPointsPerActivity:
                typeof parsed.maxPointsPerActivity === "number"
                    ? parsed.maxPointsPerActivity
                    : null,

            reservedLocationLogIds: Array.isArray(parsed.reservedLocationLogIds)
                ? parsed.reservedLocationLogIds.filter(
                      (value): value is string =>
                          typeof value === "string" && value.length > 0,
                  )
                : [],

            limitReachedReason:
                parsed.limitReachedReason === "DURATION" ||
                parsed.limitReachedReason === "POINTS"
                    ? parsed.limitReachedReason
                    : null,

            limitReachedAt:
                typeof parsed.limitReachedAt === "string"
                    ? parsed.limitReachedAt
                    : null,
        };
    } catch (error) {
        console.error("Parse recording plan limit state error:", error);

        return null;
    }
}

export async function reserveRecordingPlanPoint(
    recordingSessionId: string,
    locationLogId: string,
    recordedAtMs: number,
): Promise<RecordingPlanPointReservationResult> {
    const state = await getRecordingPlanLimitState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        /*
         * 制限stateを取得できない場合に勝手にFREE扱いして
         * 記録を止めない。
         *
         * 開始処理でstateを必ず作ることを前提とする。
         */
        return {
            allowed: true,
            state,
            reason: null,
            alreadyReserved: false,
            reachedByThisReservation: false,
        };
    }

    /*
     * Premium等、両上限がnullの場合。
     */
    if (
        state.maxActivityDurationMs === null &&
        state.maxPointsPerActivity === null
    ) {
        return {
            allowed: true,
            state,
            reason: null,
            alreadyReserved: false,
            reachedByThisReservation: false,
        };
    }

    const alreadyReserved =
        state.reservedLocationLogIds.includes(locationLogId);

    /*
     * timeout後のretryなど、同じLocationLog IDなら
     * 新しい1件として数えない。
     */
    if (alreadyReserved) {
        return {
            allowed: true,
            state,
            reason: state.limitReachedReason,
            alreadyReserved: true,
            reachedByThisReservation: false,
        };
    }

    /*
     * 2時間制限を先に確認する。
     */
    if (state.maxActivityDurationMs !== null) {
        const startedAtMs = new Date(state.recordingStartedAt).getTime();

        if (
            Number.isFinite(startedAtMs) &&
            recordedAtMs >= startedAtMs + state.maxActivityDurationMs
        ) {
            const nextState: RecordingPlanLimitState = {
                ...state,
                limitReachedReason: "DURATION",
                limitReachedAt: new Date(recordedAtMs).toISOString(),
            };

            await writeRecordingPlanLimitState(nextState);

            return {
                allowed: false,
                state: nextState,
                reason: "DURATION",
                alreadyReserved: false,
                reachedByThisReservation: false,
            };
        }
    }

    /*
     * すでにポイント上限へ到達済みなら
     * 新しいIDは予約しない。
     */
    if (
        state.maxPointsPerActivity !== null &&
        state.reservedLocationLogIds.length >= state.maxPointsPerActivity
    ) {
        const nextState: RecordingPlanLimitState = {
            ...state,
            limitReachedReason: "POINTS",
            limitReachedAt:
                state.limitReachedAt ?? new Date(recordedAtMs).toISOString(),
        };

        await writeRecordingPlanLimitState(nextState);

        return {
            allowed: false,
            state: nextState,
            reason: "POINTS",
            alreadyReserved: false,
            reachedByThisReservation: false,
        };
    }

    const nextIds = [...state.reservedLocationLogIds, locationLogId];

    const reachedByThisReservation =
        state.maxPointsPerActivity !== null &&
        nextIds.length >= state.maxPointsPerActivity;

    const nextState: RecordingPlanLimitState = {
        ...state,
        reservedLocationLogIds: nextIds,

        /*
         * 1000件目自体は保存を許可する。
         * ただしこの時点でPOINTS到達済みにすることで、
         * 次の別IDは拒否できる。
         */
        limitReachedReason: reachedByThisReservation
            ? "POINTS"
            : state.limitReachedReason,

        limitReachedAt: reachedByThisReservation
            ? new Date(recordedAtMs).toISOString()
            : state.limitReachedAt,
    };

    await writeRecordingPlanLimitState(nextState);

    return {
        allowed: true,
        state: nextState,
        reason: reachedByThisReservation ? "POINTS" : null,
        alreadyReserved: false,
        reachedByThisReservation,
    };
}

export async function releaseRecordingPlanPointReservation(
    recordingSessionId: string,
    locationLogId: string,
): Promise<void> {
    const state = await getRecordingPlanLimitState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return;
    }

    const nextIds = state.reservedLocationLogIds.filter(
        (id) => id !== locationLogId,
    );

    if (nextIds.length === state.reservedLocationLogIds.length) {
        return;
    }

    const stillAtPointLimit =
        state.maxPointsPerActivity !== null &&
        nextIds.length >= state.maxPointsPerActivity;

    await writeRecordingPlanLimitState({
        ...state,
        reservedLocationLogIds: nextIds,

        /*
         * 明示的なcreate失敗で1000件未満へ戻った場合だけ
         * POINTS到達状態も解除する。
         */
        limitReachedReason:
            state.limitReachedReason === "POINTS" && !stillAtPointLimit
                ? null
                : state.limitReachedReason,

        limitReachedAt:
            state.limitReachedReason === "POINTS" && !stillAtPointLimit
                ? null
                : state.limitReachedAt,
    });
}

export async function evaluateRecordingPlanDurationLimit(
    recordingSessionId: string,
    nowMs = Date.now(),
): Promise<RecordingPlanLimitReason | null> {
    const state = await getRecordingPlanLimitState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return null;
    }

    if (state.limitReachedReason) {
        return state.limitReachedReason;
    }

    if (state.maxActivityDurationMs === null) {
        return null;
    }

    const startedAtMs = new Date(state.recordingStartedAt).getTime();

    if (
        !Number.isFinite(startedAtMs) ||
        nowMs < startedAtMs + state.maxActivityDurationMs
    ) {
        return null;
    }

    const nextState: RecordingPlanLimitState = {
        ...state,
        limitReachedReason: "DURATION",
        limitReachedAt: new Date(nowMs).toISOString(),
    };

    await writeRecordingPlanLimitState(nextState);

    return "DURATION";
}

export async function clearRecordingPlanLimitState(
    recordingSessionId?: string | null,
): Promise<void> {
    if (!recordingSessionId) {
        await AsyncStorage.removeItem(RECORDING_PLAN_LIMIT_STATE_KEY);

        return;
    }

    const state = await getRecordingPlanLimitState();

    if (state?.recordingSessionId === recordingSessionId) {
        await AsyncStorage.removeItem(RECORDING_PLAN_LIMIT_STATE_KEY);
    }
}

async function writeRecordingPlanLimitState(
    state: RecordingPlanLimitState,
): Promise<void> {
    await AsyncStorage.setItem(
        RECORDING_PLAN_LIMIT_STATE_KEY,
        JSON.stringify(state),
    );
}
