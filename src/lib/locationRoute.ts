export type RouteLocationLog = {
    latitude: number;
    longitude: number;
    recordedAt: string;
};

export function normalizeRouteLogs<T extends RouteLocationLog>(logs: T[]) {
    return logs
        .filter(
            (log) =>
                Number.isFinite(log.latitude) &&
                Number.isFinite(log.longitude) &&
                Boolean(log.recordedAt),
        )
        .sort((a, b) => {
            return (
                new Date(a.recordedAt).getTime() -
                new Date(b.recordedAt).getTime()
            );
        })
        .filter((log, index, array) => {
            if (index === 0) {
                return true;
            }

            const previous = array[index - 1];

            return (
                Math.abs(previous.latitude - log.latitude) > 0.000001 ||
                Math.abs(previous.longitude - log.longitude) > 0.000001
            );
        });
}

export function calculateRouteDistanceMeters<T extends RouteLocationLog>(
    logs: T[],
) {
    const routeLogs = normalizeRouteLogs(logs);

    if (routeLogs.length < 2) {
        return 0;
    }

    return routeLogs.reduce((total, currentLog, index) => {
        if (index === 0) {
            return total;
        }

        const previousLog = routeLogs[index - 1];

        const distance = calculateDistanceMeters(
            previousLog.latitude,
            previousLog.longitude,
            currentLog.latitude,
            currentLog.longitude,
        );

        return total + distance;
    }, 0);
}

export function getRoutePeriod<T extends RouteLocationLog>(logs: T[]) {
    const routeLogs = normalizeRouteLogs(logs);

    if (routeLogs.length === 0) {
        return {
            startAt: null,
            endAt: null,
        };
    }

    return {
        startAt: routeLogs[0].recordedAt,
        endAt: routeLogs[routeLogs.length - 1].recordedAt,
    };
}

export function formatDistance(value: number) {
    if (!Number.isFinite(value)) {
        return "-";
    }

    if (value >= 1000) {
        return `${(value / 1000).toFixed(2)}km`;
    }

    return `${Math.round(value)}m`;
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
