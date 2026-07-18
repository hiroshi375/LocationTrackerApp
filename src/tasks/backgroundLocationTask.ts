// src/tasks/backgroundLocationTask.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { client } from "../lib/client";
import {
    getErrorMessage,
    saveBackgroundLocationDebugLog,
} from "../services/backgroundLocationDebugLogService";
import {
    calculateDistanceMeters,
    calculateSpeedMetersPerSecond,
    isAbnormalSpeedLocation,
    isExactDuplicateLocation,
    isLowAccuracyLocation,
    isNearDuplicateLocation,
} from "../utils/locationDuplicate";

export const BACKGROUND_LOCATION_TASK_NAME =
    "location-tracker-background-location-task";

export const BACKGROUND_RECORDING_STATE_KEY =
    "location-tracker-background-recording-state";

type BackgroundRecordingState = {
    userId: string;
    recordingSessionId: string;
    startedAt?: string | null;
    liveShareOwnerValues?: string[];
    liveLocationId?: string | null;
    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;
    intervalMs: number;
    distanceMeters: number;
};

type LiveLocationMutationResult = {
    data?: {
        id?: string | null;
    } | null;
    errors?: unknown;
};

type LiveLocationModel = {
    create?: (
        input: Record<string, unknown>,
    ) => Promise<LiveLocationMutationResult>;
    update?: (
        input: Record<string, unknown>,
    ) => Promise<LiveLocationMutationResult>;
};

type BackgroundLocationSkipReason =
    | "invalidCoordinate"
    | "lowAccuracy"
    | "abnormalSpeed"
    | "inProgressDuplicate"
    | "exactDuplicate"
    | "nearDuplicate"
    | "saveConditionNotMet";

type SaveBackgroundLocationResult = {
    saved: boolean;
    nextState: BackgroundRecordingState;
    skippedReason?: BackgroundLocationSkipReason;
    errorMessage?: string;
};

let savingBackgroundLocationKey: string | null = null;

type BackgroundDebugLogInput = Parameters<
    typeof saveBackgroundLocationDebugLog
>[0];

async function safeSaveBackgroundLocationDebugLog(
    input: BackgroundDebugLogInput,
): Promise<void> {
    try {
        await saveBackgroundLocationDebugLog(input);
    } catch (debugLogError) {
        console.error(
            "Failed to save background location debug log:",
            debugLogError,
        );
    }
}

TaskManager.defineTask(
    BACKGROUND_LOCATION_TASK_NAME,
    async ({ data, error }) => {
        const taskFiredAt = new Date().toISOString();

        let locationsLength = 0;
        let saveSuccessCount = 0;
        let saveFailureCount = 0;

        let skippedCount = 0;
        let invalidCoordinateSkippedCount = 0;
        let lowAccuracySkippedCount = 0;
        let abnormalSpeedSkippedCount = 0;
        let inProgressDuplicateSkippedCount = 0;
        let exactDuplicateSkippedCount = 0;
        let nearDuplicateSkippedCount = 0;
        let saveConditionSkippedCount = 0;

        try {
            const state = await getBackgroundRecordingState();

            if (error) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationTaskError",
                    taskFiredAt,
                    errorMessage: getErrorMessage(error),
                });

                console.error("Background location task error:", error);
                return;
            }

            const locations = (
                data as { locations?: Location.LocationObject[] }
            )?.locations;

            locationsLength = locations?.length ?? 0;

            await safeSaveBackgroundLocationDebugLog({
                userId: state?.userId ?? null,
                recordingSessionId: state?.recordingSessionId ?? null,
                eventName: "backgroundLocationTaskFired",
                taskFiredAt,
                locationsLength,
            });

            if (!locations || locations.length === 0) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationTaskSkippedNoLocations",
                    taskFiredAt,
                    locationsLength,
                    skippedCount: 1,
                });

                return;
            }

            if (!state?.recordingSessionId || !state.userId) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationTaskSkippedNoState",
                    taskFiredAt,
                    locationsLength,
                    skippedCount: locationsLength,
                    details: {
                        hasState: Boolean(state),
                        hasUserId: Boolean(state?.userId),
                        hasRecordingSessionId: Boolean(
                            state?.recordingSessionId,
                        ),
                    },
                });

                console.log("Background recording state not found.");
                return;
            }

            const sortedLocations = [...locations].sort((a, b) => {
                const aTime =
                    typeof a.timestamp === "number" &&
                    Number.isFinite(a.timestamp)
                        ? a.timestamp
                        : 0;

                const bTime =
                    typeof b.timestamp === "number" &&
                    Number.isFinite(b.timestamp)
                        ? b.timestamp
                        : 0;

                return aTime - bTime;
            });

            let currentState = state;

            for (const location of sortedLocations) {
                const result = await saveBackgroundLocation(
                    location,
                    currentState,
                    taskFiredAt,
                );

                if (result.saved) {
                    saveSuccessCount += 1;
                }

                if (result.errorMessage) {
                    saveFailureCount += 1;
                }

                if (result.skippedReason) {
                    skippedCount += 1;

                    switch (result.skippedReason) {
                        case "invalidCoordinate":
                            invalidCoordinateSkippedCount += 1;
                            break;
                        case "lowAccuracy":
                            lowAccuracySkippedCount += 1;
                            break;
                        case "abnormalSpeed":
                            abnormalSpeedSkippedCount += 1;
                            break;
                        case "inProgressDuplicate":
                            inProgressDuplicateSkippedCount += 1;
                            break;
                        case "exactDuplicate":
                            exactDuplicateSkippedCount += 1;
                            break;
                        case "nearDuplicate":
                            nearDuplicateSkippedCount += 1;
                            break;
                        case "saveConditionNotMet":
                            saveConditionSkippedCount += 1;
                            break;
                        default:
                            break;
                    }
                }

                currentState = result.nextState;
            }

            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
                eventName: "backgroundLocationTaskCompleted",
                taskFiredAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,

                skippedCount,
                invalidCoordinateSkippedCount,
                lowAccuracySkippedCount,
                abnormalSpeedSkippedCount,
                inProgressDuplicateSkippedCount,
                exactDuplicateSkippedCount,
                nearDuplicateSkippedCount,
                saveConditionSkippedCount,
            });
        } catch (taskError) {
            await safeSaveBackgroundLocationDebugLog({
                eventName: "backgroundLocationTaskUnexpectedError",
                taskFiredAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,

                skippedCount,
                invalidCoordinateSkippedCount,
                lowAccuracySkippedCount,
                abnormalSpeedSkippedCount,
                inProgressDuplicateSkippedCount,
                exactDuplicateSkippedCount,
                nearDuplicateSkippedCount,
                saveConditionSkippedCount,

                errorMessage: getErrorMessage(taskError),
            });

            console.error(
                "Background location task unexpected error:",
                taskError,
            );
        }
    },
);

async function getBackgroundRecordingState() {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw) as BackgroundRecordingState;
    } catch {
        return null;
    }
}

async function setBackgroundRecordingState(state: BackgroundRecordingState) {
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(state),
    );
}

async function saveBackgroundLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
): Promise<SaveBackgroundLocationResult> {
    let duplicateKeyForFinally: string | null = null;

    try {
        const latitude = location.coords.latitude;
        const longitude = location.coords.longitude;

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "invalidCoordinate",
            };
        }

        const recordedAtMs =
            typeof location.timestamp === "number" &&
            Number.isFinite(location.timestamp)
                ? location.timestamp
                : Date.now();

        const recordedAt = new Date(recordedAtMs).toISOString();
        const accuracy = location.coords.accuracy ?? null;

        if (isLowAccuracyLocation(accuracy)) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "lowAccuracy",
            };
        }

        const lastSavedLocation = state.lastSavedLocation ?? null;

        if (
            isAbnormalSpeedLocation(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            )
        ) {
            const speedMetersPerSecond = calculateSpeedMetersPerSecond(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
                eventName: "backgroundLocationLogSkippedAbnormalSpeed",
                taskFiredAt,
                details: {
                    recordedAt,
                    latitude,
                    longitude,
                    accuracy,
                    speedMetersPerSecond,
                    speedKmPerHour:
                        speedMetersPerSecond == null
                            ? null
                            : speedMetersPerSecond * 3.6,
                },
            });

            return {
                saved: false,
                nextState: state,
                skippedReason: "abnormalSpeed",
            };
        }

        const duplicateKey = createLocationDuplicateKey(
            latitude,
            longitude,
            recordedAtMs,
        );

        if (savingBackgroundLocationKey === duplicateKey) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "inProgressDuplicate",
            };
        }

        if (
            isExactDuplicateLocation(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            )
        ) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "exactDuplicate",
            };
        }

        if (
            isNearDuplicateLocation(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            )
        ) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "nearDuplicate",
            };
        }

        /*
         * 重要:
         * LocationLog を保存するかどうかとは別に、
         * 共有中なら LiveLocation は更新する。
         */
        let liveLocationId = state.liveLocationId ?? null;

        try {
            const updatedLiveLocationId = await updateBackgroundLiveLocation(
                location,
                state,
                taskFiredAt,
            );

            liveLocationId =
                updatedLiveLocationId ?? state.liveLocationId ?? null;
        } catch (liveLocationError) {
            const liveLocationErrorMessage = getErrorMessage(liveLocationError);

            console.error(
                "Background LiveLocation unexpected error:",
                liveLocationError,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
                eventName: "backgroundLiveLocationUnexpectedError",
                taskFiredAt,
                errorMessage: liveLocationErrorMessage,
                details: {
                    hasLiveLocationId: Boolean(state.liveLocationId),
                    sharedOwnersCount: state.liveShareOwnerValues?.length ?? 0,
                    errorName:
                        liveLocationError instanceof Error
                            ? liveLocationError.name
                            : typeof liveLocationError,
                    errorStack:
                        liveLocationError instanceof Error
                            ? (liveLocationError.stack ?? null)
                            : null,
                },
            });
        }

        const stateAfterLiveLocationUpdate: BackgroundRecordingState = {
            ...state,
            liveLocationId,
        };

        /*
         * ここから下は LocationLog 保存判定。
         * 保存条件を満たさなくても、LiveLocation はすでに更新済み。
         */
        if (
            !shouldSaveLocation(
                latitude,
                longitude,
                recordedAtMs,
                stateAfterLiveLocationUpdate,
            )
        ) {
            await setBackgroundRecordingState(stateAfterLiveLocationUpdate);

            return {
                saved: false,
                nextState: stateAfterLiveLocationUpdate,
                skippedReason: "saveConditionNotMet",
            };
        }

        const sharedOwners =
            stateAfterLiveLocationUpdate.liveShareOwnerValues &&
            stateAfterLiveLocationUpdate.liveShareOwnerValues.length > 0
                ? Array.from(
                      new Set(
                          stateAfterLiveLocationUpdate.liveShareOwnerValues,
                      ),
                  )
                : undefined;

        savingBackgroundLocationKey = duplicateKey;
        duplicateKeyForFinally = duplicateKey;

        const result = await client.models.LocationLog.create({
            userId: stateAfterLiveLocationUpdate.userId,
            latitude,
            longitude,
            accuracy,
            recordedAt,
            memo: "自動記録",
            recordingSessionId: stateAfterLiveLocationUpdate.recordingSessionId,
            source: "background",
            sharedOwners,
        });

        if (result.errors) {
            const errorMessage = getErrorMessage(result.errors);

            console.error(
                "Background LocationLog create errors:",
                result.errors,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: stateAfterLiveLocationUpdate.userId,
                recordingSessionId:
                    stateAfterLiveLocationUpdate.recordingSessionId,
                eventName: "backgroundLocationLogCreateFailed",
                taskFiredAt,
                errorMessage,
                details: {
                    recordedAt,
                    latitude,
                    longitude,
                },
            });

            return {
                saved: false,
                nextState: stateAfterLiveLocationUpdate,
                errorMessage,
            };
        }

        const nextState: BackgroundRecordingState = {
            ...stateAfterLiveLocationUpdate,
            lastSavedLocation: {
                latitude,
                longitude,
                recordedAt: recordedAtMs,
            },
        };

        await setBackgroundRecordingState(nextState);

        return {
            saved: true,
            nextState,
        };
    } catch (error) {
        const errorMessage = getErrorMessage(error);

        console.error("saveBackgroundLocation unexpected error:", error);

        await safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId,
            eventName: "saveBackgroundLocationUnexpectedError",
            taskFiredAt,
            errorMessage,
            details: {
                errorName: error instanceof Error ? error.name : typeof error,
                errorStack:
                    error instanceof Error ? (error.stack ?? null) : null,
            },
        });

        return {
            saved: false,
            nextState: state,
            errorMessage,
        };
    } finally {
        if (
            duplicateKeyForFinally &&
            savingBackgroundLocationKey === duplicateKeyForFinally
        ) {
            savingBackgroundLocationKey = null;
        }
    }
}

async function updateBackgroundLiveLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
): Promise<string | null | undefined> {
    const sharedOwners =
        state.liveShareOwnerValues && state.liveShareOwnerValues.length > 0
            ? Array.from(new Set(state.liveShareOwnerValues))
            : [];

    if (sharedOwners.length === 0) {
        return state.liveLocationId;
    }

    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return state.liveLocationId;
    }

    const models = client.models as unknown as {
        LiveLocation?: LiveLocationModel;
    };

    const liveLocationModel = models.LiveLocation;

    if (!liveLocationModel) {
        throw new Error("client.models.LiveLocation is not available.");
    }

    const payload: Record<string, unknown> = {
        userId: state.userId,
        recordingSessionId: state.recordingSessionId,
        latitude,
        longitude,
        accuracy: location.coords.accuracy ?? null,
        updatedAt: new Date().toISOString(),
        isActive: true,
        sharedOwners,
    };

    if (state.liveLocationId) {
        if (typeof liveLocationModel.update !== "function") {
            throw new Error(
                "client.models.LiveLocation.update is not a function.",
            );
        }

        const updateResult = await liveLocationModel.update({
            id: state.liveLocationId,
            ...payload,
        });

        if (updateResult.errors) {
            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
                eventName: "backgroundLiveLocationUpdateFailed",
                taskFiredAt,
                errorMessage: getErrorMessage(updateResult.errors),
            });

            console.error(
                "Background LiveLocation update errors:",
                updateResult.errors,
            );
        }

        return state.liveLocationId;
    }

    if (typeof liveLocationModel.create !== "function") {
        throw new Error("client.models.LiveLocation.create is not a function.");
    }

    const createResult = await liveLocationModel.create(payload);

    if (createResult.errors) {
        await safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId,
            eventName: "backgroundLiveLocationCreateFailed",
            taskFiredAt,
            errorMessage: getErrorMessage(createResult.errors),
        });

        console.error(
            "Background LiveLocation create errors:",
            createResult.errors,
        );

        return state.liveLocationId;
    }

    return createResult.data?.id ?? null;
}

const DEFAULT_DISTANCE_METERS = 100;
const DEFAULT_INTERVAL_MS = 60_000;

function createLocationDuplicateKey(
    latitude: number,
    longitude: number,
    recordedAtMs: number,
) {
    return [recordedAtMs, latitude.toFixed(7), longitude.toFixed(7)].join(":");
}

function shouldSaveLocation(
    latitude: number,
    longitude: number,
    recordedAtMs: number,
    state: BackgroundRecordingState,
) {
    const lastSavedLocation = state.lastSavedLocation;

    if (!lastSavedLocation) {
        return true;
    }

    const elapsedMs = recordedAtMs - lastSavedLocation.recordedAt;

    if (elapsedMs <= 0) {
        return false;
    }

    const distance = calculateDistanceMeters(
        lastSavedLocation.latitude,
        lastSavedLocation.longitude,
        latitude,
        longitude,
    );

    const configuredIntervalMs =
        Number.isFinite(state.intervalMs) && state.intervalMs > 0
            ? state.intervalMs
            : DEFAULT_INTERVAL_MS;

    const configuredDistanceMeters =
        Number.isFinite(state.distanceMeters) && state.distanceMeters > 0
            ? state.distanceMeters
            : DEFAULT_DISTANCE_METERS;

    /*
     * 時間間隔と距離間隔のどちらかを満たした場合に保存する。
     */
    if (elapsedMs >= configuredIntervalMs) {
        return true;
    }

    if (distance >= configuredDistanceMeters) {
        return true;
    }

    return false;
}
