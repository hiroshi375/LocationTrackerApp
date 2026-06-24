// src/tasks/backgroundLocationTask.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { client } from "../lib/client";
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
    liveShareOwnerValue?: string | null;
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

let savingBackgroundLocationKey: string | null = null;

TaskManager.defineTask(
    BACKGROUND_LOCATION_TASK_NAME,
    async ({ data, error }) => {
        try {
            if (error) {
                console.error("Background location task error:", error);
                return;
            }

            const locations = (
                data as { locations?: Location.LocationObject[] }
            )?.locations;

            if (!locations || locations.length === 0) {
                return;
            }

            const state = await getBackgroundRecordingState();

            if (!state?.recordingSessionId || !state.userId) {
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
                try {
                    const nextState = await saveBackgroundLocation(
                        location,
                        currentState,
                    );

                    if (nextState) {
                        currentState = nextState;
                    }
                } catch (saveError) {
                    console.error("Background save location error:", saveError);
                }
            }
        } catch (taskError) {
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
): Promise<BackgroundRecordingState | null> {
    let duplicateKeyForFinally: string | null = null;
    try {
        const latitude = location.coords.latitude;
        const longitude = location.coords.longitude;

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return state;
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
            return state;
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
            console.log("Skip duplicate background location:", {
                latitude,
                longitude,
                recordedAt: new Date(recordedAtMs).toISOString(),
            });

            return state;
        }
        if (!shouldSaveLocation(latitude, longitude, recordedAtMs, state)) {
            return state;
        }

        const sharedOwners = state.liveShareOwnerValue
            ? [state.liveShareOwnerValue]
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
            console.error(
                "Background LocationLog create errors:",
                result.errors,
            );
            return state;
        }

        const liveLocationId = await updateBackgroundLiveLocation(
            location,
            state,
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

        return nextState;
    } catch (error) {
        console.error("saveBackgroundLocation unexpected error:", error);
        return state;
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
): Promise<string | null | undefined> {
    if (!state.liveShareOwnerValue) {
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
        sharedOwners: [state.liveShareOwnerValue],
    };

    if (state.liveLocationId) {
        const updateResult = await liveLocationModel.update({
            id: state.liveLocationId,
            ...payload,
        });

        if (updateResult.errors) {
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
