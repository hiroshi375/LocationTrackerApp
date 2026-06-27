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
    isExactDuplicateLocation,
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

type SaveBackgroundLocationResult = {
    saved: boolean;
    nextState: BackgroundRecordingState;
    errorMessage?: string;
};

let savingBackgroundLocationKey: string | null = null;

TaskManager.defineTask(
    BACKGROUND_LOCATION_TASK_NAME,
    async ({ data, error }) => {
        const taskFiredAt = new Date().toISOString();

        let locationsLength = 0;
        let saveSuccessCount = 0;
        let saveFailureCount = 0;

        try {
            const state = await getBackgroundRecordingState();

            if (error) {
                await saveBackgroundLocationDebugLog({
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

            await saveBackgroundLocationDebugLog({
                userId: state?.userId ?? null,
                recordingSessionId: state?.recordingSessionId ?? null,
                eventName: "backgroundLocationTaskFired",
                taskFiredAt,
                locationsLength,
            });

            if (!locations || locations.length === 0) {
                await saveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationTaskSkippedNoLocations",
                    taskFiredAt,
                    locationsLength,
                });

                return;
            }

            if (!state?.recordingSessionId || !state.userId) {
                await saveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationTaskSkippedNoState",
                    taskFiredAt,
                    locationsLength,
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

                currentState = result.nextState;
            }

            await saveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
                eventName: "backgroundLocationTaskCompleted",
                taskFiredAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,
            });
        } catch (taskError) {
            await saveBackgroundLocationDebugLog({
                eventName: "backgroundLocationTaskUnexpectedError",
                taskFiredAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,
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
            };
        }

        const recordedAtMs =
            typeof location.timestamp === "number" &&
            Number.isFinite(location.timestamp)
                ? location.timestamp
                : Date.now();

        const duplicateKey = createLocationDuplicateKey(
            latitude,
            longitude,
            recordedAtMs,
        );

        if (savingBackgroundLocationKey === duplicateKey) {
            return {
                saved: false,
                nextState: state,
            };
        }

        const lastSavedLocation = state.lastSavedLocation ?? null;

        if (
            isExactDuplicateLocation(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            ) ||
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
            };
        }

        if (!shouldSaveLocation(latitude, longitude, recordedAtMs, state)) {
            return {
                saved: false,
                nextState: state,
            };
        }

        const sharedOwners =
            state.liveShareOwnerValues && state.liveShareOwnerValues.length > 0
                ? Array.from(new Set(state.liveShareOwnerValues))
                : undefined;

        const recordedAt = new Date(recordedAtMs).toISOString();

        savingBackgroundLocationKey = duplicateKey;
        duplicateKeyForFinally = duplicateKey;

        const result = await client.models.LocationLog.create({
            userId: state.userId,
            latitude,
            longitude,
            accuracy: location.coords.accuracy ?? null,
            recordedAt,
            memo: "自動記録",
            recordingSessionId: state.recordingSessionId,
            source: "background",
            sharedOwners,
        });

        if (result.errors) {
            const errorMessage = getErrorMessage(result.errors);

            console.error(
                "Background LocationLog create errors:",
                result.errors,
            );

            await saveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
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
                nextState: state,
                errorMessage,
            };
        }

        const liveLocationId = await updateBackgroundLiveLocation(
            location,
            state,
            taskFiredAt,
        );

        const nextState: BackgroundRecordingState = {
            ...state,
            liveLocationId: liveLocationId ?? state.liveLocationId ?? null,
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

        await saveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId,
            eventName: "saveBackgroundLocationUnexpectedError",
            taskFiredAt,
            errorMessage,
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

    const liveLocationModel = client.models.LiveLocation as any;

    const payload = {
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
        const updateResult = await liveLocationModel.update({
            id: state.liveLocationId,
            ...payload,
        });

        if (updateResult.errors) {
            await saveBackgroundLocationDebugLog({
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

    const createResult = (await liveLocationModel.create(
        payload,
    )) as LiveLocationMutationResult;

    if (createResult.errors) {
        await saveBackgroundLocationDebugLog({
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

const FORCE_DISTANCE_METERS = 100;

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

    //指定間隔未満なら保存しない
    if (elapsedMs < state.intervalMs && distance < FORCE_DISTANCE_METERS) {
        return false;
    }

    if (elapsedMs >= state.intervalMs) {
        return true;
    }

    //100m以上動いた場合は例外的に保存
    if (distance >= FORCE_DISTANCE_METERS) {
        return true;
    }

    return false;
}
