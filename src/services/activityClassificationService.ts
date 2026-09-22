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
/*
 * アクティビティ判定では精度の悪いGPS地点を除外する。
 *
 * 30mを超える地点は、ランニング中でも
 * 瞬間的に数十〜100m程度飛ぶことがあり、
 * 異常な高速移動として誤判定される可能性がある。
 */
const MAX_ANALYSIS_ACCURACY_METERS = 30;
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

    /*
     * 高速移動は単発の最高速度ではなく、
     * 「一定時間連続していたか」を重視して判定する。
     */
    const maxContinuousSecondsAtOrAbove18 = getMaxContinuousDurationAtOrAbove(
        analysisSegments,
        18,
    );

    const maxContinuousSecondsAtOrAbove22 = getMaxContinuousDurationAtOrAbove(
        analysisSegments,
        22,
    );

    const maxContinuousSecondsAtOrAbove25 = getMaxContinuousDurationAtOrAbove(
        analysisSegments,
        25,
    );

    const maxContinuousSecondsAtOrAbove35 = getMaxContinuousDurationAtOrAbove(
        analysisSegments,
        35,
    );

    const secondsAtOrAbove25 = sumDurationAtOrAbove(analysisSegments, 25);

    const secondsAtOrAbove35 = sumDurationAtOrAbove(analysisSegments, 35);

    /*
     * 単発のGPS飛び値ではなく、
     * 高速区間が複数存在することを確認する。
     */
    const segmentCountAtOrAbove22 = countHighSpeedRunsAtOrAbove(
        analysisSegments,
        22,
    );

    const segmentCountAtOrAbove25 = countHighSpeedRunsAtOrAbove(
        analysisSegments,
        25,
    );

    const segmentCountAtOrAbove35 = countHighSpeedRunsAtOrAbove(
        analysisSegments,
        35,
    );

    const lowSpeedSeconds = analysisSegments
        .filter((segment) => segment.speedKmh <= 12)
        .reduce((sum, segment) => sum + segment.durationSeconds, 0);

    const highSpeedSeconds = analysisSegments
        .filter((segment) => segment.speedKmh >= 22)
        .reduce((sum, segment) => sum + segment.durationSeconds, 0);

    /*
     * 複合移動と判定するには、
     *
     * ・低速移動が2分以上存在
     * ・22km/h以上の高速移動が存在
     *
     * に加えて、
     *
     * ① 22km/h以上が60秒以上連続
     *
     * または
     *
     * ② 22km/h以上の区間が複数あり、
     *    合計60秒以上
     *
     * のどちらかを要求する。
     *
     * GPS飛び値1件だけではMIXEDにならない。
     */
    const hasSustainedHighSpeedMovement =
        maxContinuousSecondsAtOrAbove22 >= 60 ||
        (highSpeedSeconds >= 60 && segmentCountAtOrAbove22 >= 3);

    const hasClearlyMixedMovement =
        lowSpeedSeconds >= 120 && hasSustainedHighSpeedMovement;

    /*
     * 乗り物判定。
     *
     * 単発の最高速度だけでは判定しない。
     *
     * 次のいずれかを満たした場合だけ、
     * 乗り物相当の高速移動と判断する。
     *
     * 1. 35km/h以上が30秒以上連続
     * 2. 25km/h以上が120秒以上連続
     * 3. 35km/h以上が合計60秒以上かつ3区間以上
     * 4. 25km/h以上が合計180秒以上かつ5区間以上
     * 5. 95%点が45km/h以上かつ35km/h以上が3区間以上
     */
    const hasVehicleSpeedMovement =
        maxContinuousSecondsAtOrAbove35 >= 30 ||
        maxContinuousSecondsAtOrAbove25 >= 120 ||
        (secondsAtOrAbove35 >= 60 && segmentCountAtOrAbove35 >= 3) ||
        (secondsAtOrAbove25 >= 180 && segmentCountAtOrAbove25 >= 5) ||
        (p95SpeedKmh >= 45 && segmentCountAtOrAbove35 >= 3);

    if (hasVehicleSpeedMovement) {
        return createResult(
            hasClearlyMixedMovement ? "MIXED" : "VEHICLE",
            [
                "乗り物相当の高速移動を継続的に検出しました。",
                `平均${averageSpeedKmh.toFixed(1)}km/h`,
                `90%点${p90SpeedKmh.toFixed(1)}km/h`,
                `最高${maxSpeedKmh.toFixed(1)}km/h`,
                `35km/h以上連続${Math.round(
                    maxContinuousSecondsAtOrAbove35,
                )}秒`,
            ].join(" "),
            averageSpeedKmh,
            maxSpeedKmh,
            movingDurationSeconds,
        );
    }

    if (
        maxContinuousSecondsAtOrAbove18 >= 60 ||
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
                `18km/h以上連続${Math.round(
                    maxContinuousSecondsAtOrAbove18,
                )}秒`,
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

function countHighSpeedRunsAtOrAbove(
    segments: SpeedSegment[],
    thresholdKmh: number,
): number {
    let count = 0;
    let inHighSpeedRun = false;

    for (const segment of segments) {
        if (segment.speedKmh >= thresholdKmh) {
            if (!inHighSpeedRun) {
                count += 1;
                inHighSpeedRun = true;
            }
        } else {
            inHighSpeedRun = false;
        }
    }

    return count;
}

function getMaxContinuousDurationAtOrAbove(
    segments: SpeedSegment[],
    thresholdKmh: number,
): number {
    let currentDurationSeconds = 0;
    let maxDurationSeconds = 0;

    for (const segment of segments) {
        if (segment.speedKmh >= thresholdKmh) {
            currentDurationSeconds += segment.durationSeconds;

            maxDurationSeconds = Math.max(
                maxDurationSeconds,
                currentDurationSeconds,
            );
        } else {
            currentDurationSeconds = 0;
        }
    }

    return maxDurationSeconds;
}

function roundNumber(value: number, digits: number): number {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}
