export type SavedLocationLike = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

export const EXACT_DUPLICATE_DISTANCE_METERS = 1;
export const NEAR_DUPLICATE_TIME_MS = 3000;
export const NEAR_DUPLICATE_DISTANCE_METERS = 5;
export const MAX_LOCATION_ACCURACY_METERS = 100;
export const MAX_REASONABLE_SPEED_KMH = 200;
export const MAX_REASONABLE_SPEED_METERS_PER_SECOND =
    MAX_REASONABLE_SPEED_KMH / 3.6;

export function isExactDuplicateLocation(
    savedLocation: SavedLocationLike | null,
    latitude: number,
    longitude: number,
    recordedAtMs: number,
) {
    if (!savedLocation) {
        return false;
    }

    if (savedLocation.recordedAt !== recordedAtMs) {
        return false;
    }

    const distance = calculateDistanceMeters(
        savedLocation.latitude,
        savedLocation.longitude,
        latitude,
        longitude,
    );

    return distance < EXACT_DUPLICATE_DISTANCE_METERS;
}

export function isNearDuplicateLocation(
    savedLocation: SavedLocationLike | null,
    latitude: number,
    longitude: number,
    recordedAtMs: number,
) {
    if (!savedLocation) {
        return false;
    }

    const elapsedMs = Math.abs(recordedAtMs - savedLocation.recordedAt);

    if (elapsedMs > NEAR_DUPLICATE_TIME_MS) {
        return false;
    }

    const distance = calculateDistanceMeters(
        savedLocation.latitude,
        savedLocation.longitude,
        latitude,
        longitude,
    );

    return distance <= NEAR_DUPLICATE_DISTANCE_METERS;
}

export function isLowAccuracyLocation(
    accuracy: number | null | undefined,
    maxAccuracyMeters: number = MAX_LOCATION_ACCURACY_METERS,
) {
    if (accuracy == null) {
        return false;
    }

    if (!Number.isFinite(accuracy)) {
        return true;
    }

    return accuracy > maxAccuracyMeters;
}

export function calculateSpeedMetersPerSecond(
    savedLocation: SavedLocationLike | null,
    latitude: number,
    longitude: number,
    recordedAtMs: number,
) {
    if (!savedLocation) {
        return null;
    }

    const elapsedSeconds = (recordedAtMs - savedLocation.recordedAt) / 1000;

    if (elapsedSeconds <= 0) {
        return null;
    }

    const distanceMeters = calculateDistanceMeters(
        savedLocation.latitude,
        savedLocation.longitude,
        latitude,
        longitude,
    );

    return distanceMeters / elapsedSeconds;
}

export function isAbnormalSpeedLocation(
    savedLocation: SavedLocationLike | null,
    latitude: number,
    longitude: number,
    recordedAtMs: number,
    maxSpeedMetersPerSecond: number = MAX_REASONABLE_SPEED_METERS_PER_SECOND,
) {
    const speedMetersPerSecond = calculateSpeedMetersPerSecond(
        savedLocation,
        latitude,
        longitude,
        recordedAtMs,
    );

    if (speedMetersPerSecond == null) {
        return false;
    }

    return speedMetersPerSecond > maxSpeedMetersPerSecond;
}

export function calculateDistanceMeters(
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
