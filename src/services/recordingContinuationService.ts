import AsyncStorage from "@react-native-async-storage/async-storage";

const RECORDING_CONTINUATION_STATE_KEY =
    "location-tracker-recording-continuation-state";

export const RECORDING_CONTINUATION_HOUR_INTERVAL_MS = 60 * 60 * 1000;
export const RECORDING_CONTINUATION_POINT_INTERVAL = 1000;
export const RECORDING_CONTINUATION_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;

export type RecordingContinuationReason = "TIME" | "POINTS" | "BOTH";

export type RecordingContinuationState = {
    recordingSessionId: string;
    recordingStartedAt: string;
    savedPointCount: number;
    confirmedElapsedHours: number;
    confirmedPointMilestone: number;

    confirmationRequired: boolean;
    confirmationReason: RecordingContinuationReason | null;
    confirmationRequestedAt: string | null;
    confirmationDeadlineAt: string | null;

    recordingExpiresAt: string | null;
    requestedElapsedHours: number;
    requestedPointMilestone: number;

    lastConfirmedAt: string | null;
    confirmationCount: number;

    autoStoppedAt: string | null;
};

export type RecordingContinuationEvaluation = {
    state: RecordingContinuationState | null;
    shouldShowConfirmation: boolean;
    isDeadlineExpired: boolean;
};

export type RecordingContinuationEvaluationOptions = {
    /**
     * 継続確認が必要になった場合に、
     * confirmationRequestedAt / confirmationDeadlineAt を作成して
     * 3分タイムアウトを開始してよいか。
     *
     * foregroundで実際に確認UIを表示できる場合だけ true にする。
     */
    startConfirmationTimeout?: boolean;
};

export async function initializeRecordingContinuationState(
    recordingSessionId: string,
    recordingStartedAt: string,
): Promise<RecordingContinuationState> {
    const state: RecordingContinuationState = {
        recordingSessionId,
        recordingStartedAt,
        savedPointCount: 0,
        confirmedElapsedHours: 0,
        confirmedPointMilestone: 0,
        confirmationRequired: false,
        confirmationReason: null,
        confirmationRequestedAt: null,
        confirmationDeadlineAt: null,
        recordingExpiresAt: null,
        requestedElapsedHours: 0,
        requestedPointMilestone: 0,

        lastConfirmedAt: null,
        confirmationCount: 0,

        autoStoppedAt: null,
    };

    await writeRecordingContinuationState(state);
    return state;
}

export async function getRecordingContinuationState(): Promise<RecordingContinuationState | null> {
    const raw = await AsyncStorage.getItem(RECORDING_CONTINUATION_STATE_KEY);

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<RecordingContinuationState>;

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
            recordingStartedAt: parsed.recordingStartedAt,
            savedPointCount: normalizeNonNegativeInteger(
                parsed.savedPointCount,
            ),
            confirmedElapsedHours: normalizeNonNegativeInteger(
                parsed.confirmedElapsedHours,
            ),
            confirmedPointMilestone: normalizeNonNegativeInteger(
                parsed.confirmedPointMilestone,
            ),
            confirmationRequired: parsed.confirmationRequired === true,
            confirmationReason: normalizeReason(parsed.confirmationReason),
            confirmationRequestedAt:
                typeof parsed.confirmationRequestedAt === "string"
                    ? parsed.confirmationRequestedAt
                    : null,
            confirmationDeadlineAt:
                typeof parsed.confirmationDeadlineAt === "string"
                    ? parsed.confirmationDeadlineAt
                    : null,
            recordingExpiresAt:
                typeof parsed.recordingExpiresAt === "string"
                    ? parsed.recordingExpiresAt
                    : typeof parsed.confirmationDeadlineAt === "string"
                      ? parsed.confirmationDeadlineAt
                      : null,
            requestedElapsedHours: normalizeNonNegativeInteger(
                parsed.requestedElapsedHours,
            ),
            requestedPointMilestone: normalizeNonNegativeInteger(
                parsed.requestedPointMilestone,
            ),
            lastConfirmedAt:
                typeof parsed.lastConfirmedAt === "string"
                    ? parsed.lastConfirmedAt
                    : null,

            confirmationCount: normalizeNonNegativeInteger(
                parsed.confirmationCount,
            ),

            autoStoppedAt:
                typeof parsed.autoStoppedAt === "string"
                    ? parsed.autoStoppedAt
                    : null,
        };
    } catch (error) {
        console.error("Parse recording continuation state error:", error);
        return null;
    }
}

export async function incrementRecordingContinuationPointCount(
    recordingSessionId: string,
    nowMs: number = Date.now(),
    options: RecordingContinuationEvaluationOptions = {},
): Promise<RecordingContinuationEvaluation> {
    const state = await getRecordingContinuationState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return {
            state,
            shouldShowConfirmation: false,
            isDeadlineExpired: false,
        };
    }

    const nextState: RecordingContinuationState = {
        ...state,
        savedPointCount: state.savedPointCount + 1,
    };

    return evaluateAndPersist(
        nextState,
        nowMs,
        options.startConfirmationTimeout === true,
    );
}

export async function evaluateRecordingContinuation(
    recordingSessionId: string,
    nowMs: number = Date.now(),
    options: RecordingContinuationEvaluationOptions = {},
): Promise<RecordingContinuationEvaluation> {
    const state = await getRecordingContinuationState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return {
            state,
            shouldShowConfirmation: false,
            isDeadlineExpired: false,
        };
    }

    return evaluateAndPersist(
        state,
        nowMs,
        options.startConfirmationTimeout === true,
    );
}

export async function confirmRecordingContinuation(
    recordingSessionId: string,
    nowMs: number = Date.now(),
): Promise<RecordingContinuationState | null> {
    const state = await getRecordingContinuationState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return state;
    }

    const elapsedHours = calculateElapsedHours(state.recordingStartedAt, nowMs);
    const pointMilestone = calculatePointMilestone(state.savedPointCount);
    const confirmedAt = new Date(nowMs).toISOString();

    const nextState: RecordingContinuationState = {
        ...state,
        confirmedElapsedHours: Math.max(
            state.confirmedElapsedHours,
            state.requestedElapsedHours,
            elapsedHours,
        ),
        confirmedPointMilestone: Math.max(
            state.confirmedPointMilestone,
            state.requestedPointMilestone,
            pointMilestone,
        ),
        confirmationRequired: false,
        confirmationReason: null,
        confirmationRequestedAt: null,
        confirmationDeadlineAt: null,
        recordingExpiresAt: null,
        requestedElapsedHours: 0,
        requestedPointMilestone: 0,
        lastConfirmedAt: confirmedAt,
        confirmationCount: state.confirmationCount + 1,
    };

    await writeRecordingContinuationState(nextState);
    return nextState;
}

export async function pauseRecordingContinuationConfirmation(
    recordingSessionId: string,
): Promise<RecordingContinuationState | null> {
    const state = await getRecordingContinuationState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return state;
    }

    /*
     * まだ継続確認中でなければ何もしない。
     */
    if (!state.confirmationRequired) {
        return state;
    }

    /*
     * Backgroundへ移行したため、
     * 継続確認の3分タイムアウトを解除する。
     *
     * 次回Foregroundへ戻った時に再評価され、
     * その時点から新しく3分タイムアウトを開始する。
     */
    const nextState: RecordingContinuationState = {
        ...state,
        confirmationRequired: false,
        confirmationReason: null,
        confirmationRequestedAt: null,
        confirmationDeadlineAt: null,
        recordingExpiresAt: null,
        requestedElapsedHours: 0,
        requestedPointMilestone: 0,
    };

    await writeRecordingContinuationState(nextState);

    return nextState;
}

export async function markRecordingContinuationAutoStopped(
    recordingSessionId: string,
    nowIso: string = new Date().toISOString(),
): Promise<RecordingContinuationState | null> {
    const state = await getRecordingContinuationState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return state;
    }

    const nextState: RecordingContinuationState = {
        ...state,
        confirmationRequired: false,
        recordingExpiresAt:
            state.recordingExpiresAt ?? state.confirmationDeadlineAt ?? nowIso,
        autoStoppedAt: nowIso,
    };

    await writeRecordingContinuationState(nextState);
    return nextState;
}

export async function clearRecordingContinuationState(
    recordingSessionId?: string | null,
): Promise<void> {
    if (!recordingSessionId) {
        await AsyncStorage.removeItem(RECORDING_CONTINUATION_STATE_KEY);
        return;
    }

    const current = await getRecordingContinuationState();

    if (current?.recordingSessionId === recordingSessionId) {
        await AsyncStorage.removeItem(RECORDING_CONTINUATION_STATE_KEY);
    }
}

async function evaluateAndPersist(
    state: RecordingContinuationState,
    nowMs: number,
    startConfirmationTimeout: boolean,
): Promise<RecordingContinuationEvaluation> {
    if (state.autoStoppedAt) {
        return {
            state,
            shouldShowConfirmation: false,
            isDeadlineExpired: true,
        };
    }

    if (state.confirmationRequired && state.confirmationDeadlineAt) {
        const deadlineMs = new Date(state.confirmationDeadlineAt).getTime();

        const isDeadlineExpired =
            Number.isFinite(deadlineMs) && nowMs >= deadlineMs;

        /*
         * incrementRecordingContinuationPointCount() から渡された場合に、
         * confirmation待ち中でも最新のsavedPointCountを保持する。
         */
        await writeRecordingContinuationState(state);

        return {
            state,
            shouldShowConfirmation: !isDeadlineExpired,
            isDeadlineExpired,
        };
    }

    const elapsedHours = calculateElapsedHours(state.recordingStartedAt, nowMs);
    const pointMilestone = calculatePointMilestone(state.savedPointCount);

    const timeReached = elapsedHours > state.confirmedElapsedHours;
    const pointsReached = pointMilestone > state.confirmedPointMilestone;

    if (!timeReached && !pointsReached) {
        await writeRecordingContinuationState(state);

        return {
            state,
            shouldShowConfirmation: false,
            isDeadlineExpired: false,
        };
    }

    const reason: RecordingContinuationReason =
        timeReached && pointsReached ? "BOTH" : timeReached ? "TIME" : "POINTS";

    /*
     * 1時間経過 / ポイント到達は認識するが、
     * background側からの評価では3分タイムアウトを開始しない。
     *
     * foregroundへ戻った際に再評価され、
     * その時点から3分タイムアウトを開始する。
     */
    if (!startConfirmationTimeout) {
        await writeRecordingContinuationState(state);

        return {
            state,
            shouldShowConfirmation: false,
            isDeadlineExpired: false,
        };
    }

    const requestedAt = new Date(nowMs).toISOString();
    const deadlineAt = new Date(
        nowMs + RECORDING_CONTINUATION_RESPONSE_TIMEOUT_MS,
    ).toISOString();

    const nextState: RecordingContinuationState = {
        ...state,
        confirmationRequired: true,
        confirmationReason: reason,
        confirmationRequestedAt: requestedAt,
        confirmationDeadlineAt: deadlineAt,
        recordingExpiresAt: deadlineAt,
        requestedElapsedHours: timeReached ? elapsedHours : 0,
        requestedPointMilestone: pointsReached ? pointMilestone : 0,
    };

    await writeRecordingContinuationState(nextState);

    return {
        state: nextState,
        shouldShowConfirmation: true,
        isDeadlineExpired: false,
    };
}

function calculateElapsedHours(startedAt: string, nowMs: number): number {
    const startedAtMs = new Date(startedAt).getTime();

    if (!Number.isFinite(startedAtMs) || nowMs <= startedAtMs) {
        return 0;
    }

    return Math.floor(
        (nowMs - startedAtMs) / RECORDING_CONTINUATION_HOUR_INTERVAL_MS,
    );
}

function calculatePointMilestone(savedPointCount: number): number {
    return Math.floor(savedPointCount / RECORDING_CONTINUATION_POINT_INTERVAL);
}

async function writeRecordingContinuationState(
    state: RecordingContinuationState,
): Promise<void> {
    await AsyncStorage.setItem(
        RECORDING_CONTINUATION_STATE_KEY,
        JSON.stringify(state),
    );
}

function normalizeNonNegativeInteger(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : 0;
}

function normalizeReason(value: unknown): RecordingContinuationReason | null {
    return value === "TIME" || value === "POINTS" || value === "BOTH"
        ? value
        : null;
}
