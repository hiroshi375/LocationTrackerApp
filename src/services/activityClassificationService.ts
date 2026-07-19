import {
    calculateDistanceMeters,
    calculateSpeedMetersPerSecond,
} from "../utils/locationDuplicate";

export const ACTIVITY_TYPES = [
    "WALKING",
    "RUNNING",
    "CYCLING",
    "VEHICLE",
    "MIXED",
    "UNKNOWN",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
    WALKING: "徒歩",
    RUNNING: "ランニング",
    CYCLING: "自転車",
    VEHICLE: "乗り物",
    MIXED: "複合移動",
    UNKNOWN: "未判定",
};

export type ActivityClassificationSource = "AUTO" | "MANUAL";

export type ActivityClassificationResult = {
    activityType: ActivityType;
    isAggregationTarget: boolean;
    classificationSource: ActivityClassificationSource;
    classificationReason: string;
    averageSpeedKmh: number;
    maxSpeedKmh: number;
    movingDurationSeconds: number;
};

export type ActivityLocationLog = {
    latitude: number;
    longitude: number;
    recordedAt: string;
    accuracy?: number | null;
};

type SpeedSegment = {
    durationSeconds: number;
    distanceMeters: number;
    speedKmh: number;
};

const MIN_VALID_SEGMENT_SECONDS = 1;
const MAX_VALID_SEGMENT_SECONDS = 5 * 60;
const MAX_ANALYSIS_ACCURACY_METERS = 100;
const MAX_ANALYSIS_SPEED_KMH = 200;

export function isAggregationTargetActivityType(
    activityType: ActivityType,
): boolean {
    return activityType === "WALKING" || activityType === "RUNNING";
}

export function normalizeActivityType(value: unknown): ActivityType {
    return ACTIVITY_TYPES.includes(value as ActivityType)
        ? (value as ActivityType)
        : "UNKNOWN";
}

export function classifyActivitySession(
    inputLogs: ActivityLocationLog[],
): ActivityClassificationResult {
    const logs = inputLogs
        .filter(
            (log) =>
                Number.isFinite(log.latitude) &&
                Number.isFinite(log.longitude) &&
                Number.isFinite(new Date(log.recordedAt).getTime()) &&
                (log.accuracy == null ||
                    (Number.isFinite(log.accuracy) &&
                        log.accuracy <= MAX_ANALYSIS_ACCURACY_METERS)),
        )
        .sort(
            (a, b) =>
                new Date(a.recordedAt).getTime() -
                new Date(b.recordedAt).getTime(),
        );

    if (logs.length < 2) {
        return createResult(
            "UNKNOWN",
            "有効な位置情報が2件未満のため判定できませんでした。",
            0,
            0,
            0,
        );
    }

    const segments: SpeedSegment[] = [];

    for (let index = 1; index < logs.length; index += 1) {
        const previous = logs[index - 1];
        const current = logs[index];

        const previousAt = new Date(previous.recordedAt).getTime();
        const currentAt = new Date(current.recordedAt).getTime();
        const durationSeconds = (currentAt - previousAt) / 1000;

        if (
            durationSeconds < MIN_VALID_SEGMENT_SECONDS ||
            durationSeconds > MAX_VALID_SEGMENT_SECONDS
        ) {
            continue;
        }

        const distanceMeters = calculateDistanceMeters(
            previous.latitude,
            previous.longitude,
            current.latitude,
            current.longitude,
        );

        const speedMetersPerSecond = calculateSpeedMetersPerSecond(
            {
                latitude: previous.latitude,
                longitude: previous.longitude,
                recordedAt: previousAt,
            },
            current.latitude,
            current.longitude,
            currentAt,
        );

        if (
            speedMetersPerSecond == null ||
            !Number.isFinite(speedMetersPerSecond)
        ) {
            continue;
        }

        const speedKmh = speedMetersPerSecond * 3.6;

        if (speedKmh > MAX_ANALYSIS_SPEED_KMH) {
            continue;
        }

        segments.push({
            durationSeconds,
            distanceMeters,
            speedKmh,
        });
    }

    if (segments.length === 0) {
        return createResult(
            "UNKNOWN",
            "有効な移動区間を抽出できなかったため判定できませんでした。",
            0,
            0,
            0,
        );
    }

    const movingSegments = segments.filter(
        (segment) => segment.speedKmh >= 0.8,
    );
    const analysisSegments =
        movingSegments.length > 0 ? movingSegments : segments;

    const movingDurationSeconds = Math.round(
        analysisSegments.reduce(
            (sum, segment) => sum + segment.durationSeconds,
            0,
        ),
    );
    const movingDistanceMeters = analysisSegments.reduce(
        (sum, segment) => sum + segment.distanceMeters,
        0,
    );

    const averageSpeedKmh =
        movingDurationSeconds > 0
            ? (movingDistanceMeters / movingDurationSeconds) * 3.6
            : 0;

    const speeds = analysisSegments
        .map((segment) => segment.speedKmh)
        .sort((a, b) => a - b);

    const maxSpeedKmh = speeds[speeds.length - 1] ?? 0;
    const p90SpeedKmh = percentile(speeds, 0.9);
    const p95SpeedKmh = percentile(speeds, 0.95);

    const secondsAtOrAbove18 = sumDurationAtOrAbove(analysisSegments, 18);
    const secondsAtOrAbove25 = sumDurationAtOrAbove(analysisSegments, 25);
    const secondsAtOrAbove35 = sumDurationAtOrAbove(analysisSegments, 35);

    const lowSpeedSeconds = analysisSegments
        .filter((segment) => segment.speedKmh <= 12)
        .reduce((sum, segment) => sum + segment.durationSeconds, 0);

    const highSpeedSeconds = analysisSegments
        .filter((segment) => segment.speedKmh >= 22)
        .reduce((sum, segment) => sum + segment.durationSeconds, 0);

    const hasClearlyMixedMovement =
        lowSpeedSeconds >= 120 && highSpeedSeconds >= 60;

    if (
        secondsAtOrAbove35 >= 60 ||
        secondsAtOrAbove25 >= 180 ||
        p95SpeedKmh >= 45 ||
        maxSpeedKmh >= 70
    ) {
        return createResult(
            hasClearlyMixedMovement ? "MIXED" : "VEHICLE",
            [
                "乗り物相当の高速移動を検出しました。",
                `平均${averageSpeedKmh.toFixed(1)}km/h`,
                `90%点${p90SpeedKmh.toFixed(1)}km/h`,
                `最高${maxSpeedKmh.toFixed(1)}km/h`,
            ].join(" "),
            averageSpeedKmh,
            maxSpeedKmh,
            movingDurationSeconds,
        );
    }

    if (
        secondsAtOrAbove18 >= 120 ||
        p90SpeedKmh >= 20 ||
        averageSpeedKmh >= 14
    ) {
        return createResult(
            hasClearlyMixedMovement ? "MIXED" : "CYCLING",
            [
                "自転車相当の速度が継続しました。",
                `平均${averageSpeedKmh.toFixed(1)}km/h`,
                `90%点${p90SpeedKmh.toFixed(1)}km/h`,
                `最高${maxSpeedKmh.toFixed(1)}km/h`,
            ].join(" "),
            averageSpeedKmh,
            maxSpeedKmh,
            movingDurationSeconds,
        );
    }

    if (averageSpeedKmh >= 6 || p90SpeedKmh >= 8.5) {
        return createResult(
            "RUNNING",
            [
                "徒歩より速く、自転車相当の継続速度は検出されませんでした。",
                `平均${averageSpeedKmh.toFixed(1)}km/h`,
                `90%点${p90SpeedKmh.toFixed(1)}km/h`,
                `最高${maxSpeedKmh.toFixed(1)}km/h`,
            ].join(" "),
            averageSpeedKmh,
            maxSpeedKmh,
            movingDurationSeconds,
        );
    }

    return createResult(
        "WALKING",
        [
            "徒歩相当の移動速度でした。",
            `平均${averageSpeedKmh.toFixed(1)}km/h`,
            `90%点${p90SpeedKmh.toFixed(1)}km/h`,
            `最高${maxSpeedKmh.toFixed(1)}km/h`,
        ].join(" "),
        averageSpeedKmh,
        maxSpeedKmh,
        movingDurationSeconds,
    );
}

function createResult(
    activityType: ActivityType,
    classificationReason: string,
    averageSpeedKmh: number,
    maxSpeedKmh: number,
    movingDurationSeconds: number,
): ActivityClassificationResult {
    return {
        activityType,
        isAggregationTarget: isAggregationTargetActivityType(activityType),
        classificationSource: "AUTO",
        classificationReason,
        averageSpeedKmh: roundNumber(averageSpeedKmh, 2),
        maxSpeedKmh: roundNumber(maxSpeedKmh, 2),
        movingDurationSeconds,
    };
}

function percentile(sortedValues: number[], ratio: number): number {
    if (sortedValues.length === 0) {
        return 0;
    }

    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
    );

    return sortedValues[index] ?? 0;
}

function sumDurationAtOrAbove(
    segments: SpeedSegment[],
    thresholdKmh: number,
): number {
    return segments
        .filter((segment) => segment.speedKmh >= thresholdKmh)
        .reduce((sum, segment) => sum + segment.durationSeconds, 0);
}

function roundNumber(value: number, digits: number): number {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}
