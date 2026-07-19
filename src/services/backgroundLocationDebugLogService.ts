import { client } from "../lib/client";

type BackgroundLocationDebugLogInput = {
    userId?: string | null;
    recordingSessionId?: string | null;
    eventName: string;

    taskFiredAt?: string | null;
    locationsLength?: number | null;
    saveSuccessCount?: number | null;
    saveFailureCount?: number | null;

    skippedCount?: number | null;
    lowAccuracySkippedCount?: number | null;
    abnormalSpeedSkippedCount?: number | null;
    invalidCoordinateSkippedCount?: number | null;
    inProgressDuplicateSkippedCount?: number | null;
    exactDuplicateSkippedCount?: number | null;
    nearDuplicateSkippedCount?: number | null;
    saveConditionSkippedCount?: number | null;

    hasStartedLocationUpdates?: boolean | null;

    foregroundPermissionStatus?: string | null;
    foregroundPermissionGranted?: boolean | null;
    foregroundPermissionCanAskAgain?: boolean | null;

    backgroundPermissionStatus?: string | null;
    backgroundPermissionGranted?: boolean | null;
    backgroundPermissionCanAskAgain?: boolean | null;

    errorMessage?: string | null;

    details?: Record<string, unknown>;
};

type BackgroundDebugLogMode = "ALL" | "IMPORTANT" | "ERROR_ONLY";

const UNKNOWN_USER_ID = "unknown";
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_DETAILS_JSON_LENGTH = 4000;

/*
 * ALL:
 *   調査用。正常系・異常系を含むすべてのイベントを保存する。
 *
 * IMPORTANT:
 *   定義済みの正常系・異常系イベントだけ保存する。
 *
 * ERROR_ONLY:
 *   異常系イベントだけ保存する。
 */
const BACKGROUND_DEBUG_LOG_MODE: BackgroundDebugLogMode = "ALL";

const NORMAL_EVENT_NAMES = new Set([
    // バックグラウンドタスクの正常動作確認
    "backgroundLocationTrackingStarted",
    "backgroundLocationTaskFired",
    "backgroundLocationTaskCompleted",
    "backgroundLocationTaskSkippedNoLocations",
    // 権限・ネイティブタスク状態
    "backgroundLocationPermissionStatus",
    "backgroundLocationUpdatesStatus",
]);

const ERROR_EVENT_NAMES = new Set([
    // バックグラウンドタスク自体の異常
    "backgroundLocationTaskError",
    "backgroundLocationTaskUnexpectedError",
    "saveBackgroundLocationUnexpectedError",
    // LocationLog保存失敗
    "backgroundLocationLogCreateFailed",
    "foregroundLocationLogCreateFailed",
    // LiveLocation作成・更新失敗
    "backgroundLiveLocationCreateFailed",
    "backgroundLiveLocationUpdateFailed",
    "foregroundLiveLocationCreateFailed",
    "foregroundLiveLocationUpdateFailed",
    "foregroundLiveLocationUnexpectedError",
    // 通常起きるべきではない状態
    "foregroundLocationLogSkippedNoUserId",
]);

function shouldSaveBackgroundLocationDebugLog(eventName: string): boolean {
    switch (BACKGROUND_DEBUG_LOG_MODE) {
        case "ALL":
            return true;

        case "IMPORTANT":
            return (
                NORMAL_EVENT_NAMES.has(eventName) ||
                ERROR_EVENT_NAMES.has(eventName)
            );

        case "ERROR_ONLY":
            return ERROR_EVENT_NAMES.has(eventName);

        default:
            return false;
    }
}

export function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === "string") {
        return error;
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export async function saveBackgroundLocationDebugLog(
    input: BackgroundLocationDebugLogInput,
) {
    if (!shouldSaveBackgroundLocationDebugLog(input.eventName)) {
        return;
    }

    try {
        const userId = input.userId ?? UNKNOWN_USER_ID;

        const debugLogModel = client.models.BackgroundLocationDebugLog as any;

        const detailsJson = stringifyDetails(input.details);

        const result = await debugLogModel.create({
            userId,
            recordingSessionId: input.recordingSessionId ?? null,
            eventName: input.eventName,
            loggedAt: new Date().toISOString(),

            taskFiredAt: input.taskFiredAt ?? null,
            locationsLength: input.locationsLength ?? null,
            saveSuccessCount: input.saveSuccessCount ?? null,
            saveFailureCount: input.saveFailureCount ?? null,

            skippedCount: input.skippedCount ?? null,
            invalidCoordinateSkippedCount:
                input.invalidCoordinateSkippedCount ?? null,
            lowAccuracySkippedCount: input.lowAccuracySkippedCount ?? null,
            abnormalSpeedSkippedCount: input.abnormalSpeedSkippedCount ?? null,
            inProgressDuplicateSkippedCount:
                input.inProgressDuplicateSkippedCount ?? null,
            exactDuplicateSkippedCount:
                input.exactDuplicateSkippedCount ?? null,
            nearDuplicateSkippedCount: input.nearDuplicateSkippedCount ?? null,
            saveConditionSkippedCount: input.saveConditionSkippedCount ?? null,

            hasStartedLocationUpdates: input.hasStartedLocationUpdates ?? null,

            foregroundPermissionStatus:
                input.foregroundPermissionStatus ?? null,
            foregroundPermissionGranted:
                input.foregroundPermissionGranted ?? null,
            foregroundPermissionCanAskAgain:
                input.foregroundPermissionCanAskAgain ?? null,

            backgroundPermissionStatus:
                input.backgroundPermissionStatus ?? null,
            backgroundPermissionGranted:
                input.backgroundPermissionGranted ?? null,
            backgroundPermissionCanAskAgain:
                input.backgroundPermissionCanAskAgain ?? null,

            errorMessage: truncateText(
                input.errorMessage,
                MAX_ERROR_MESSAGE_LENGTH,
            ),
            detailsJson: truncateText(detailsJson, MAX_DETAILS_JSON_LENGTH),
        });

        if (result.errors) {
            console.error(
                "BackgroundLocationDebugLog create errors:",
                result.errors,
                {
                    eventName: input.eventName,
                    userId,
                    recordingSessionId: input.recordingSessionId ?? null,
                },
            );
        }
    } catch (error) {
        console.error("Save background debug log error:", error, {
            eventName: input.eventName,
            userId: input.userId ?? UNKNOWN_USER_ID,
            recordingSessionId: input.recordingSessionId ?? null,
        });
    }
}

function stringifyDetails(details?: Record<string, unknown>) {
    if (!details) {
        return null;
    }

    try {
        return JSON.stringify(details);
    } catch {
        return JSON.stringify({
            stringifyError: true,
        });
    }
}

function truncateText(value: string | null | undefined, maxLength: number) {
    if (!value) {
        return null;
    }

    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}...`;
}
