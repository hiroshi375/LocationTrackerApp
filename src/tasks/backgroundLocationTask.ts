// src/tasks/backgroundLocationTask.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { client } from "../lib/client";

export const BACKGROUND_LOCATION_TASK_NAME =
    "location-tracker-background-location-task";

export const BACKGROUND_RECORDING_STATE_KEY =
    "location-tracker-background-recording-state";

type BackgroundRecordingState = {
    userId: string;
    recordingSessionId: string;
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

TaskManager.defineTask(
    BACKGROUND_LOCATION_TASK_NAME,
    async ({ data, error }) => {
        if (error) {
            console.error("Background location task error:", error);
            return;
        }

        const locations = (data as { locations?: Location.LocationObject[] })
            ?.locations;

        if (!locations || locations.length === 0) {
            return;
        }

        const state = await getBackgroundRecordingState();

        if (!state?.recordingSessionId || !state.userId) {
            return;
        }

        for (const location of locations) {
            await saveBackgroundLocation(location, state);
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
) {
    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
    }

    if (!shouldSaveLocation(latitude, longitude, state)) {
        return;
    }

    const recordedAt = new Date().toISOString();

    const sharedOwners = state.liveShareOwnerValue
        ? [state.liveShareOwnerValue]
        : undefined;

    const result = await client.models.LocationLog.create({
        userId: state.userId,
        latitude,
        longitude,
        accuracy: location.coords.accuracy ?? null,
        recordedAt,
        memo: "自動記録",
        recordingSessionId: state.recordingSessionId,
        sharedOwners,
    });

    if (result.errors) {
        console.error("Background LocationLog create errors:", result.errors);
        return;
    }

    await updateBackgroundLiveLocation(location, state);

    await setBackgroundRecordingState({
        ...state,
        lastSavedLocation: {
            latitude,
            longitude,
            recordedAt: Date.now(),
        },
    });
}

async function updateBackgroundLiveLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
) {
    if (!state.liveShareOwnerValue) {
        return;
    }

    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
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

        return;
    }

    const createResult = (await liveLocationModel.create(
        payload,
    )) as LiveLocationMutationResult;

    if (createResult.errors) {
        console.error(
            "Background LiveLocation create errors:",
            createResult.errors,
        );
        return;
    }

    await setBackgroundRecordingState({
        ...state,
        liveLocationId: createResult.data?.id ?? null,
    });
}

function shouldSaveLocation(
    latitude: number,
    longitude: number,
    state: BackgroundRecordingState,
) {
    const lastSavedLocation = state.lastSavedLocation;

    if (!lastSavedLocation) {
        return true;
    }

    const elapsedMs = Date.now() - lastSavedLocation.recordedAt;

    const distance = calculateDistanceMeters(
        lastSavedLocation.latitude,
        lastSavedLocation.longitude,
        latitude,
        longitude,
    );

    if (elapsedMs >= state.intervalMs) {
        return true;
    }

    if (distance >= state.distanceMeters) {
        return true;
    }

    return false;
}

function calculateDistanceMeters(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
) {
    const earthRadiusMeters = 6371000;

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) *
            Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusMeters * c;
}

function toRadians(value: number) {
    return (value * Math.PI) / 180;
}
