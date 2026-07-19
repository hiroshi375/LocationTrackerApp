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
    requestedElapsedHours: number;
    requestedPointMilestone: number;
    autoStoppedAt: string | null;
};

export type RecordingContinuationEvaluation = {
    state: RecordingContinuationState | null;
    shouldShowConfirmation: boolean;
    isDeadlineExpired: boolean;
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
        requestedElapsedHours: 0,
        requestedPointMilestone: 0,
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
            requestedElapsedHours: normalizeNonNegativeInteger(
                parsed.requestedElapsedHours,
            ),
            requestedPointMilestone: normalizeNonNegativeInteger(
                parsed.requestedPointMilestone,
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

    return evaluateAndPersist(nextState, nowMs);
}

export async function evaluateRecordingContinuation(
    recordingSessionId: string,
    nowMs: number = Date.now(),
): Promise<RecordingContinuationEvaluation> {
    const state = await getRecordingContinuationState();

    if (!state || state.recordingSessionId !== recordingSessionId) {
        return {
            state,
            shouldShowConfirmation: false,
            isDeadlineExpired: false,
        };
    }

    return evaluateAndPersist(state, nowMs);
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
        return {
            state,
            shouldShowConfirmation: false,
            isDeadlineExpired: false,
        };
    }

    const reason: RecordingContinuationReason =
        timeReached && pointsReached ? "BOTH" : timeReached ? "TIME" : "POINTS";

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
