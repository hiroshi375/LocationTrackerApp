import { getCurrentUser } from "aws-amplify/auth";

import { client } from "../lib/client";

type BackgroundLocationDebugLogInput = {
    userId?: string | null;
    recordingSessionId?: string | null;
    eventName: string;

    taskFiredAt?: string | null;
    locationsLength?: number | null;
    saveSuccessCount?: number | null;
    saveFailureCount?: number | null;

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
    try {
        let userId = input.userId ?? null;

        if (!userId) {
            try {
                const currentUser = await getCurrentUser();
                userId = currentUser.userId;
            } catch {
                userId = "unknown";
            }
        }

        const debugLogModel = client.models.BackgroundLocationDebugLog as any;

        const result = await debugLogModel.create({
            userId,
            recordingSessionId: input.recordingSessionId ?? null,
            eventName: input.eventName,
            loggedAt: new Date().toISOString(),

            taskFiredAt: input.taskFiredAt ?? null,
            locationsLength: input.locationsLength ?? null,
            saveSuccessCount: input.saveSuccessCount ?? null,
            saveFailureCount: input.saveFailureCount ?? null,

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

            errorMessage: input.errorMessage ?? null,
            detailsJson: input.details ? JSON.stringify(input.details) : null,
        });

        if (result.errors) {
            console.error(
                "BackgroundLocationDebugLog create errors:",
                result.errors,
            );
        }
    } catch (error) {
        // 診断ログ保存の失敗で本体処理を止めない
        console.error("Save background debug log error:", error);
    }
}
