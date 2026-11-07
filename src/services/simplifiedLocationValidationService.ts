import * as Application from "expo-application";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { LocationObject } from "expo-location";
import { SIMPLIFIED_LOCATION_VALIDATION } from "../config/locationValidation";
import { selectScopedNativeLocation } from "./simplifiedLocationValidationCore";

export const simplifiedLocationValidationEnabled = SIMPLIFIED_LOCATION_VALIDATION && Platform.OS === "android"
    && Application.applicationId === "com.hiroshisato.locationtrackerapp.incident104";
export async function readSimplifiedRecordingLocation(userId: string, sessionId: string): Promise<LocationObject | null> {
    if (!simplifiedLocationValidationEnabled) return null;
    const native = requireOptionalNativeModule<{ readAcLogLatestRecordingLocationAsync: () => Promise<string | null> }>("ExpoLocation");
    if (!native?.readAcLogLatestRecordingLocationAsync) throw new Error("SIMPLIFIED_LOCATION_BRIDGE_MISSING");
    return selectScopedNativeLocation(await native.readAcLogLatestRecordingLocationAsync(), userId, sessionId, Date.now());
}
