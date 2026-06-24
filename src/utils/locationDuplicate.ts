export type SavedLocationLike = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

export const EXACT_DUPLICATE_DISTANCE_METERS = 1;
export const NEAR_DUPLICATE_TIME_MS = 3000;
export const NEAR_DUPLICATE_DISTANCE_METERS = 5;

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
