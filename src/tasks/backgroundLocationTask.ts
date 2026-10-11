// src/tasks/backgroundLocationTask.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchAuthSession } from "aws-amplify/auth";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import {
    ENABLE_LOCATION_SQLITE_MIRROR,
    ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD,
    KEEP_DIRECT_LOCATION_LOG_SAVE,
} from "../config/locationQueueFeatureFlags";

import { client } from "../lib/client";
import {
    getErrorMessage,
    saveBackgroundLocationDebugLog,
} from "../services/backgroundLocationDebugLogService";
import {
    acquireLocationSaveLock,
    createLocationLogId,
    createLocationSaveLockScopeKey,
    createLocationUniqueKey,
    isDuplicateLocationCreateError,
    releaseLocationSaveLock,
    type LocationSaveLock,
} from "../services/locationLogDeduplicationService";
import { incrementRecordingContinuationPointCount } from "../services/recordingContinuationService";
import {
    evaluateRecordingPlanDurationLimit,
    releaseRecordingPlanPointReservation,
    reserveRecordingPlanPoint,
} from "../services/recordingPlanLimitService";
import {
    calculateDistanceMeters,
    calculateSpeedMetersPerSecond,
    isAbnormalSpeedLocation,
    isExactDuplicateLocation,
    isLowAccuracyLocation,
    isNearDuplicateLocation,
} from "../utils/locationDuplicate";
import { upsertLiveLocation } from "../services/liveLocationMutationService";

export const BACKGROUND_LOCATION_TASK_NAME =
    "location-tracker-background-location-task";

export const BACKGROUND_RECORDING_STATE_KEY =
    "location-tracker-background-recording-state";
/*
 * Foreground側が最後にLocationLog保存成功した地点を保持するキー。
 *
 * backgroundLocationService.ts の
 * FOREGROUND_LAST_SAVED_LOCATION_KEY と同じ値を使用する。
 *
 * backgroundLocationService.ts はこのbackgroundLocationTask.tsを
 * importしているため、循環importを避けてここでは同じキー文字列を定義する。
 */
const FOREGROUND_LAST_SAVED_LOCATION_KEY =
    "location-tracker-foreground-last-saved-location";
/**
 * バックグラウンド位置タスクが実際に呼び出された時刻を保存するキー。
 *
 * タスク登録状態ではなく、OSからタスクコールバックが配送されたことを
 * 確認するために使用する。
 */
export const BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY =
    "location-tracker-background-location-task-heartbeat";

/**
 * Background task が最後にどの処理段階まで進んだかを
 * eventId単位で端末内へ保存する診断用キー。
 *
 * 重要：
 * 診断保存そのものがBackground taskをブロックしないよう、
 * AsyncStorage.setItem() は await しない。
 */
export const BACKGROUND_LOCATION_TASK_STAGE_PREFIX =
    "location-tracker-background-location-task-stage:";

/**
 * Background task のstage診断をAsyncStorageへ保存するか。
 *
 * true:
 *   Development Buildでstage診断を保存する。
 *
 * false:
 *   Production / Google Play Closed Testでは保存しない。
 *
 * React Nativeの__DEV__は、
 * 開発実行時=true、release build=false。
 */
const ENABLE_BACKGROUND_LOCATION_TASK_STAGE_DIAGNOSTICS = true;

/**
 * stage診断を有効化した場合でも、
 * AsyncStorageへ無制限に蓄積させない。
 *
 * 1 eventId = 1 Background callback。
 */
const BACKGROUND_LOCATION_TASK_STAGE_MAX_ENTRIES = 200;

/**
 * prune時に大量のキーを一度に削除しないための単位。
 */
const BACKGROUND_LOCATION_TASK_STAGE_DELETE_BATCH_SIZE = 200;

/**
 * 過去版で無制限に作成されていたstage診断を
 * 一度だけ削除したことを記録するキー。
 */
const BACKGROUND_LOCATION_TASK_STAGE_CLEANUP_VERSION_KEY =
    "location-tracker-background-location-task-stage-cleanup-version";

/**
 * cleanup内容を変更した場合は、この値を上げる。
 */
const BACKGROUND_LOCATION_TASK_STAGE_CLEANUP_VERSION = "1";

type BackgroundLocationTaskStage =
    | "TASK_ENTRY"
    | "KEEPALIVE_TIMER_SCHEDULED"
    | "STATE_LOAD_START"
    | "STATE_LOAD_END"
    | "HEARTBEAT_SAVE_START"
    | "HEARTBEAT_SAVE_END"
    | "SQLITE_MIRROR_IMPORT_START"
    | "SQLITE_MIRROR_IMPORT_END"
    | "SQLITE_MIRROR_START"
    | "SQLITE_MIRROR_END"
    | "QUEUE_MAINTENANCE_IMPORT_START"
    | "QUEUE_MAINTENANCE_IMPORT_END"
    | "QUEUE_SUMMARY_START"
    | "QUEUE_SUMMARY_END"
    | "QUEUE_CLEANUP_START"
    | "QUEUE_CLEANUP_END"
    | "AUTH_START"
    | "AUTH_END"
    | "DIRECT_SAVE_LOOP_START"
    | "DIRECT_SAVE_LOCATION_START"
    | "DIRECT_SAVE_LOCATION_END"
    | "DIRECT_SAVE_LOOP_END"
    | "LIVE_LOCATION_START"
    | "LIVE_LOCATION_END"
    | "QUEUE_UPLOAD_IMPORT_START"
    | "QUEUE_UPLOAD_IMPORT_END"
    | "QUEUE_UPLOAD_START"
    | "QUEUE_UPLOAD_END"
    | "BATCH_DEBUG_LOG_START"
    | "BATCH_DEBUG_LOG_END"
    | "TASK_RETURNING"
    | "TASK_ERROR"
    | "UNEXPECTED_DEBUG_LOG_START"
    | "UNEXPECTED_DEBUG_LOG_END"
    | "TASK_FINALLY";

type BackgroundTaskStageContext = {
    eventId: string;
    taskName: string | null;
    taskStartedAtMs: number;
};

/*
 * 同一eventIdのAsyncStorage書き込みを直列化する。
 *
 * Background Task本体ではawaitしない。
 * 診断保存の滞留で位置情報処理を停止させないため。
 */
const backgroundStageWriteQueues = new Map<string, Promise<void>>();

let backgroundStageFinishedCounter = 0;
let backgroundStagePruneRunning = false;

function recordBackgroundTaskStage(
    context: BackgroundTaskStageContext,
    stage: BackgroundLocationTaskStage,
    details?: Record<string, unknown>,
): void {
    if (!ENABLE_BACKGROUND_LOCATION_TASK_STAGE_DIAGNOSTICS) {
        return;
    }

    const stageAtMs = Date.now();

    const payload = {
        runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
        eventId: context.eventId,
        taskName: context.taskName,
        taskStartedAtMs: context.taskStartedAtMs,
        stage,
        stageAtMs,
        stageAt: new Date(stageAtMs).toISOString(),
        elapsedMs: stageAtMs - context.taskStartedAtMs,
        ...(details ?? {}),
    };

    console.log("[BG_TASK_STAGE]", payload);

    const key = `${BACKGROUND_LOCATION_TASK_STAGE_PREFIX}${context.eventId}`;

    const previousWrite =
        backgroundStageWriteQueues.get(context.eventId) ?? Promise.resolve();

    const currentWrite = previousWrite
        .catch(() => {
            // 前回の診断失敗で次の記録を止めない
        })
        .then(async () => {
            await AsyncStorage.setItem(key, JSON.stringify(payload));
        })
        .catch((error) => {
            console.error("[BG_TASK_STAGE_SAVE_FAILED]", {
                eventId: context.eventId,
                stage,
                error: getErrorMessage(error),
            });
        });

    backgroundStageWriteQueues.set(context.eventId, currentWrite);

    if (stage === "TASK_FINALLY") {
        void currentWrite.then(() => {
            /*
             * このイベントの最終書き込みが
             * 完了した場合にだけキューを削除。
             */
            if (
                backgroundStageWriteQueues.get(context.eventId) === currentWrite
            ) {
                backgroundStageWriteQueues.delete(context.eventId);
            }

            backgroundStageFinishedCounter += 1;

            /*
             * 毎回全キーを走査すると負荷が高いため、
             * 50イベントごとに整理する。
             */
            if (backgroundStageFinishedCounter % 50 === 0) {
                void runBackgroundStagePruneSafely();
            }
        });
    }
}

async function runBackgroundStagePruneSafely(): Promise<void> {
    if (backgroundStagePruneRunning) {
        return;
    }

    backgroundStagePruneRunning = true;

    try {
        await pruneBackgroundLocationTaskStageDiagnostics();
    } catch (error) {
        console.error("[BG_TASK_STAGE_PRUNE_FAILED]", getErrorMessage(error));
    } finally {
        backgroundStagePruneRunning = false;
    }
}

async function pruneBackgroundLocationTaskStageDiagnostics(): Promise<void> {
    if (!ENABLE_BACKGROUND_LOCATION_TASK_STAGE_DIAGNOSTICS) {
        return;
    }

    const allKeys = await AsyncStorage.getAllKeys();

    const stageKeys = allKeys.filter((key) =>
        key.startsWith(BACKGROUND_LOCATION_TASK_STAGE_PREFIX),
    );

    if (stageKeys.length <= BACKGROUND_LOCATION_TASK_STAGE_MAX_ENTRIES) {
        return;
    }

    /*
     * eventId自体は時系列順とは限らないため、
     * value内のstageAtMsを使って並べる。
     */
    const entries = await AsyncStorage.multiGet(stageKeys);

    const entriesWithTimestamp = entries.map(([key, value]) => {
        let stageAtMs = 0;

        if (value) {
            try {
                const parsed = JSON.parse(value) as {
                    stageAtMs?: unknown;
                };

                if (
                    typeof parsed.stageAtMs === "number" &&
                    Number.isFinite(parsed.stageAtMs)
                ) {
                    stageAtMs = parsed.stageAtMs;
                }
            } catch {
                /*
                 * 壊れた診断値は最古扱いにして削除候補とする。
                 */
                stageAtMs = 0;
            }
        }

        return {
            key,
            stageAtMs,
        };
    });

    entriesWithTimestamp.sort((a, b) => a.stageAtMs - b.stageAtMs);

    const deleteCount =
        entriesWithTimestamp.length -
        BACKGROUND_LOCATION_TASK_STAGE_MAX_ENTRIES;

    const keysToDelete = entriesWithTimestamp
        .slice(0, deleteCount)
        .map((entry) => entry.key);

    /*
     * まだ書き込み中のイベントは削除しない。
     *
     * 削除対象が後続のcallbackで更新されることによる
     * 診断データ欠落を防ぐ。
     */
    const safeKeysToDelete = keysToDelete.filter((key) => {
        const eventId = key.slice(BACKGROUND_LOCATION_TASK_STAGE_PREFIX.length);

        return !backgroundStageWriteQueues.has(eventId);
    });

    await removeAsyncStorageKeysInBatches(safeKeysToDelete);

    console.log("[BG_TASK_STAGE_PRUNED]", {
        beforeCount: stageKeys.length,
        deletedCount: keysToDelete.length,
        remainingCount: stageKeys.length - keysToDelete.length,
        maxEntries: BACKGROUND_LOCATION_TASK_STAGE_MAX_ENTRIES,
    });
}

type BackgroundTaskStageRecord = {
    eventId: string;
    runtimeBootId: string;
    taskName: string | null;
    taskStartedAtMs: number;
    stage: string;
    stageAtMs: number;
    elapsedMs: number;
};

export type BackgroundTaskStageDiagnostic = {
    totalCount: number;
    unfinishedCount: number;
    latest: {
        eventId: string;
        stage: string;
        stageAt: string;
        elapsedMs: number;
    } | null;
    unfinished: {
        eventId: string;
        stage: string;
        startedAt: string;
        lastStageAt: string;
        elapsedMs: number;
        ageMs: number;
    }[];
};

export async function getBackgroundTaskStageDiagnostic(): Promise<BackgroundTaskStageDiagnostic> {
    /*
     * 診断取得時にも整理する。
     * これにより画面表示時の件数を抑制する。
     */
    await runBackgroundStagePruneSafely();

    const allKeys = await AsyncStorage.getAllKeys();

    const stageKeys = allKeys.filter((key) =>
        key.startsWith(BACKGROUND_LOCATION_TASK_STAGE_PREFIX),
    );

    const entries = await AsyncStorage.multiGet(stageKeys);

    const records: BackgroundTaskStageRecord[] = [];

    for (const [, raw] of entries) {
        if (!raw) {
            continue;
        }

        try {
            const parsed = JSON.parse(raw) as BackgroundTaskStageRecord;

            if (
                typeof parsed.eventId !== "string" ||
                typeof parsed.stage !== "string" ||
                !Number.isFinite(parsed.taskStartedAtMs) ||
                !Number.isFinite(parsed.stageAtMs)
            ) {
                continue;
            }

            records.push(parsed);
        } catch {
            // 壊れた診断データはスキップ
        }
    }

    records.sort((a, b) => b.stageAtMs - a.stageAtMs);

    const nowMs = Date.now();

    const unfinished = records
        .filter((record) => record.stage !== "TASK_FINALLY")
        .map((record) => ({
            eventId: record.eventId,
            stage: record.stage,
            startedAt: new Date(record.taskStartedAtMs).toISOString(),
            lastStageAt: new Date(record.stageAtMs).toISOString(),
            elapsedMs: record.stageAtMs - record.taskStartedAtMs,
            ageMs: Math.max(0, nowMs - record.taskStartedAtMs),
        }));

    const latest = records[0] ?? null;

    return {
        totalCount: records.length,
        unfinishedCount: unfinished.length,
        latest: latest
            ? {
                  eventId: latest.eventId,
                  stage: latest.stage,
                  stageAt: new Date(latest.stageAtMs).toISOString(),
                  elapsedMs: latest.stageAtMs - latest.taskStartedAtMs,
              }
            : null,
        unfinished,
    };
}

async function removeAsyncStorageKeysInBatches(keys: string[]): Promise<void> {
    for (
        let index = 0;
        index < keys.length;
        index += BACKGROUND_LOCATION_TASK_STAGE_DELETE_BATCH_SIZE
    ) {
        const batch = keys.slice(
            index,
            index + BACKGROUND_LOCATION_TASK_STAGE_DELETE_BATCH_SIZE,
        );

        if (batch.length === 0) {
            continue;
        }

        await AsyncStorage.multiRemove(batch);
    }
}

/*
 * 1callbackで大量地点が再配送された場合は、
 * SQLite mirror / direct LocationLog保存を優先し、
 * SQLite queue uploadは後続callbackへ回す。
 *
 * この値は距離(m)ではなく「地点数」。
 */
const BACKGROUND_QUEUE_UPLOAD_DEFER_BATCH_SIZE = 50;

export type BackgroundLocationTaskHeartbeat = {
    /**
     * タスクコールバックが開始された端末時刻。
     */
    firedAt: number;
    /**
     * firedAtのISO形式。
     * ログ確認をしやすくするため保持する。
     */
    taskFiredAt: string;
    /**
     * OSから渡された位置情報件数。
     */
    locationsLength: number;
    /**
     * タスク実行時点の記録セッションID。
     *
     * 状態取得前や非記録中の場合はnull。
     */
    recordingSessionId: string | null;
    /**
     * タスク実行時点で自動記録中だったか。
     */
    isRecording: boolean;
    /**
     * タスク実行時点のユーザーID。
     *
     * 状態取得前や状態不明の場合はnull。
     */
    userId: string | null;
    /**
     * TaskManagerからエラーが渡されたか。
     */
    hasTaskError: boolean;
};

/*
 * BackgroundLocationDebugLog の保存を一括で制御する。
 *
 * false:
 *   DynamoDB の BackgroundLocationDebugLog に新しいレコードを作成しない。
 *
 * 再調査が必要になった場合だけ、一時的に true に戻す。
 */
const ENABLE_BACKGROUND_LOCATION_DEBUG_LOG = true;

type BackgroundRecordingState = {
    userId: string;

    isRecording: boolean;
    recordingSessionId?: string | null;
    startedAt?: string | null;

    liveShareOwnerValues: string[];
    liveLocationId?: string | null;

    lastSavedLocation?: SavedLocation | null;

    intervalMs: number;
    distanceMeters: number;
    shareRevision?: number;
};

type SavedLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

type BackgroundLocationSkipReason =
    | "invalidCoordinate"
    | "lowAccuracy"
    | "abnormalSpeed"
    | "inProgressDuplicate"
    | "exactDuplicate"
    | "nearDuplicate"
    | "saveConditionNotMet"
    | "planLimitReached";

type SaveBackgroundLocationResult = {
    saved: boolean;
    nextState: BackgroundRecordingState;
    skippedReason?: BackgroundLocationSkipReason;
    errorMessage?: string;
};

type UpdateBackgroundLiveLocationResult = {
    nextState: BackgroundRecordingState;

    /*
     * 共有先がなく、更新処理自体を実行しなかった場合はfalse。
     */
    attempted: boolean;

    /*
     * createまたはupdateが正常終了した場合はtrue。
     * attempted=falseの場合もfalse。
     */
    succeeded: boolean;

    /*
     * create/updateのどちらを試したか。
     */
    operation: "none" | "create" | "update";

    /*
     * エラー時のメッセージ。
     */
    errorMessage?: string;

    /*
     * タイムアウトだったか。
     */
    timedOut: boolean;

    /*
     * LiveLocation ID。
     * create成功時は新しく作られたID。
     */
    liveLocationId?: string | null;
};

type BackgroundLocationProcessingTimings = {
    lockAcquireDurationMs: number;
    preCreateLookupDurationMs: number;
    locationLogCreateDurationMs: number;
    stateUpdateDurationMs: number;
    continuationUpdateDurationMs: number;

    lockAcquireCount: number;
    preCreateLookupCount: number;
    locationLogCreateCount: number;
    stateUpdateCount: number;
    continuationUpdateCount: number;

    lockAcquireMaxDurationMs: number;
    preCreateLookupMaxDurationMs: number;
    locationLogCreateMaxDurationMs: number;
    stateUpdateMaxDurationMs: number;
    continuationUpdateMaxDurationMs: number;
};

type BackgroundAuthSessionResult = {
    available: boolean;
    refreshed: boolean;
    hasIdToken: boolean;
    hasAccessToken: boolean;
    errorMessage?: string;
};

function createBackgroundLocationProcessingTimings(): BackgroundLocationProcessingTimings {
    return {
        lockAcquireDurationMs: 0,
        preCreateLookupDurationMs: 0,
        locationLogCreateDurationMs: 0,
        stateUpdateDurationMs: 0,
        continuationUpdateDurationMs: 0,

        lockAcquireCount: 0,
        preCreateLookupCount: 0,
        locationLogCreateCount: 0,
        stateUpdateCount: 0,
        continuationUpdateCount: 0,

        lockAcquireMaxDurationMs: 0,
        preCreateLookupMaxDurationMs: 0,
        locationLogCreateMaxDurationMs: 0,
        stateUpdateMaxDurationMs: 0,
        continuationUpdateMaxDurationMs: 0,
    };
}

type BackgroundDebugLogInput = Parameters<
    typeof saveBackgroundLocationDebugLog
>[0];

async function safeSaveBackgroundLocationDebugLog(
    input: BackgroundDebugLogInput,
): Promise<void> {
    if (!ENABLE_BACKGROUND_LOCATION_DEBUG_LOG) {
        return;
    }

    try {
        await saveBackgroundLocationDebugLog(input);
    } catch (debugLogError) {
        console.error(
            "Failed to save background location debug log:",
            debugLogError,
        );
    }
}

/**
 * バックグラウンド位置タスクの実行記録をAsyncStorageへ保存する。
 *
 * heartbeat保存失敗によって既存のLocationLog処理を停止させないため、
 * 例外はこの関数内で処理する。
 */
async function safeSaveBackgroundLocationTaskHeartbeat(
    heartbeat: BackgroundLocationTaskHeartbeat,
): Promise<void> {
    try {
        await AsyncStorage.setItem(
            BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY,
            JSON.stringify(heartbeat),
        );
    } catch (heartbeatError) {
        console.error(
            "Save background location task heartbeat error:",
            heartbeatError,
        );
    }
}

function isUnauthorizedError(error: unknown): boolean {
    let text: string;

    if (typeof error === "string") {
        text = error;
    } else {
        try {
            text = JSON.stringify(error);
        } catch {
            text = String(error);
        }
    }

    const normalizedText = text.toLowerCase();

    return (
        normalizedText.includes("unauthorized") ||
        normalizedText.includes("not authorized") ||
        normalizedText.includes("unauthenticated") ||
        normalizedText.includes("401")
    );
}

/**
 * バックグラウンドでのLiveLocation作成・更新の最大待機時間。
 *
 * タイムアウトしても開始済み通信はキャンセルされないため、
 * タイムアウト時は次回の位置イベントで再試行する。
 */
const LIVE_LOCATION_UPDATE_TIMEOUT_MS = 5_000;

/**
 * LocationLog.create() 1回あたりの最大待機時間。
 *
 * タイムアウトしても、開始済みの通信自体をキャンセルするわけではない。
 * そのため、決定的IDによる重複防止を前提とする。
 */
const LOCATION_LOG_CREATE_TIMEOUT_MS = 10_000;

/**
 * バックグラウンド処理開始前の通常認証取得の最大待機時間。
 */
const AUTH_SESSION_FETCH_TIMEOUT_MS = 8_000;

/**
 * 認証セッション強制更新の最大待機時間。
 */
const AUTH_SESSION_REFRESH_TIMEOUT_MS = 10_000;

class OperationTimeoutError extends Error {
    readonly operationName: string;
    readonly timeoutMs: number;

    // 長時間・PC非接続テスト用のtimer診断情報
    readonly runtimeBootId: string;
    readonly scheduledAtMs: number;
    readonly expectedFireAtMs: number;
    readonly actuallyFiredAtMs: number;
    readonly timerDriftMs: number;

    constructor(
        operationName: string,
        timeoutMs: number,
        runtimeBootId: string,
        scheduledAtMs: number,
        expectedFireAtMs: number,
        actuallyFiredAtMs: number,
    ) {
        super(`${operationName} timed out after ${timeoutMs}ms.`);

        this.name = "OperationTimeoutError";
        this.operationName = operationName;
        this.timeoutMs = timeoutMs;

        this.runtimeBootId = runtimeBootId;
        this.scheduledAtMs = scheduledAtMs;
        this.expectedFireAtMs = expectedFireAtMs;
        this.actuallyFiredAtMs = actuallyFiredAtMs;
        this.timerDriftMs = actuallyFiredAtMs - expectedFireAtMs;
    }
}

function isOperationTimeoutError(
    error: unknown,
): error is OperationTimeoutError {
    return error instanceof OperationTimeoutError;
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    /*
     * setTimeoutを登録した時刻と、
     * 本来発火するはずの時刻を記録する。
     *
     * Android Background中にJS timerが停止していないかを
     * 実測するための診断ログ。
     */
    const scheduledAtMs = Date.now();
    const expectedFireAtMs = scheduledAtMs + timeoutMs;

    console.log("[BG_TIMER_SCHEDULED]", {
        runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
        operationName,
        timeoutMs,
        scheduledAtMs,
        scheduledAt: new Date(scheduledAtMs).toISOString(),
        expectedFireAtMs,
        expectedFireAt: new Date(expectedFireAtMs).toISOString(),
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            const actuallyFiredAtMs = Date.now();

            console.log("[BG_TIMER_FIRED]", {
                runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
                operationName,
                timeoutMs,
                scheduledAtMs,
                scheduledAt: new Date(scheduledAtMs).toISOString(),
                expectedFireAtMs,
                expectedFireAt: new Date(expectedFireAtMs).toISOString(),
                actuallyFiredAtMs,
                actuallyFiredAt: new Date(actuallyFiredAtMs).toISOString(),
                /*
                 * ここが重要。
                 * 正常：
                 *   0～数十ms程度
                 * 異常：
                 *   数秒～数分
                 */
                timerDriftMs: actuallyFiredAtMs - expectedFireAtMs,
            });

            reject(
                new OperationTimeoutError(
                    operationName,
                    timeoutMs,
                    BACKGROUND_RUNTIME_BOOT_ID,
                    scheduledAtMs,
                    expectedFireAtMs,
                    actuallyFiredAtMs,
                ),
            );
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);

            const clearedAtMs = Date.now();

            console.log("[BG_TIMER_CLEARED]", {
                runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
                operationName,
                timeoutMs,
                scheduledAtMs,
                expectedFireAtMs,
                clearedAtMs,
                clearedAt: new Date(clearedAtMs).toISOString(),
                elapsedMs: clearedAtMs - scheduledAtMs,
            });
        }
    }
}

async function prepareBackgroundAuthSession(): Promise<BackgroundAuthSessionResult> {
    try {
        /*
         * 通常の認証セッション取得にもタイムアウトを設定する。
         *
         * 有効期限切れの場合は、Amplifyがrefresh tokenを利用できれば
         * 通常取得の中でセッション更新が行われる。
         */
        let session = await withTimeout(
            fetchAuthSession(),
            AUTH_SESSION_FETCH_TIMEOUT_MS,
            "Background auth session fetch",
        );

        let hasIdToken = Boolean(session.tokens?.idToken);
        let hasAccessToken = Boolean(session.tokens?.accessToken);

        if (hasIdToken && hasAccessToken) {
            return {
                available: true,
                refreshed: false,
                hasIdToken,
                hasAccessToken,
            };
        }

        /*
         * トークンが取得できなかった場合だけ、
         * 1回限定で強制更新する。
         */
        session = await withTimeout(
            fetchAuthSession({
                forceRefresh: true,
            }),
            AUTH_SESSION_REFRESH_TIMEOUT_MS,
            "Background auth session force refresh",
        );

        hasIdToken = Boolean(session.tokens?.idToken);
        hasAccessToken = Boolean(session.tokens?.accessToken);

        return {
            available: hasIdToken && hasAccessToken,
            refreshed: true,
            hasIdToken,
            hasAccessToken,
        };
    } catch (error) {
        const errorMessage = getErrorMessage(error);

        console.error("Prepare background auth session error:", error);

        return {
            available: false,
            refreshed: false,
            hasIdToken: false,
            hasAccessToken: false,
            errorMessage,
        };
    }
}

type LocationLogCreateInput = {
    id: string;
    userId: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    recordedAt: string;
    memo: string;
    recordingSessionId: string;
    source: string;
    sharedOwners?: string[];
    locationUniqueKey: string;
};

type LocationLogCreateWithAuthRetryResult = {
    result: any;
    authRefreshAttempted: boolean;
    authRefreshSucceeded: boolean;
};

async function createLocationLogWithAuthRetry(
    input: LocationLogCreateInput,
): Promise<LocationLogCreateWithAuthRetryResult> {
    let firstResult: any;

    try {
        firstResult = await withTimeout(
            client.models.LocationLog.create(input),
            LOCATION_LOG_CREATE_TIMEOUT_MS,
            "Background LocationLog.create",
        );
    } catch (error) {
        /*
         * タイムアウトは認証エラーではないため、そのまま呼び出し元へ返す。
         *
         * タイムアウト後も内部通信が遅れて成功する可能性があるが、
         * LocationLogでは決定的IDを使用しているため、
         * 次回再送時は重複として安全に処理できる。
         */
        if (isOperationTimeoutError(error)) {
            throw error;
        }

        if (!isUnauthorizedError(error)) {
            throw error;
        }

        try {
            await withTimeout(
                fetchAuthSession({
                    forceRefresh: true,
                }),
                AUTH_SESSION_REFRESH_TIMEOUT_MS,
                "Background auth force refresh",
            );
        } catch (refreshError) {
            console.error(
                "Background auth force refresh failed:",
                refreshError,
            );

            throw refreshError;
        }

        const retryResult = await withTimeout(
            client.models.LocationLog.create(input),
            LOCATION_LOG_CREATE_TIMEOUT_MS,
            "Background LocationLog.create retry",
        );

        return {
            result: retryResult,
            authRefreshAttempted: true,
            authRefreshSucceeded: true,
        };
    }

    if (!firstResult.errors || !isUnauthorizedError(firstResult.errors)) {
        return {
            result: firstResult,
            authRefreshAttempted: false,
            authRefreshSucceeded: false,
        };
    }

    try {
        await withTimeout(
            fetchAuthSession({
                forceRefresh: true,
            }),
            AUTH_SESSION_REFRESH_TIMEOUT_MS,
            "Background auth force refresh",
        );
    } catch (refreshError) {
        console.error("Background auth force refresh failed:", refreshError);

        /*
         * 最初のUnauthorized結果は取得できているため、
         * 従来どおり呼び出し元へ返す。
         */
        return {
            result: firstResult,
            authRefreshAttempted: true,
            authRefreshSucceeded: false,
        };
    }

    const retryResult = await withTimeout(
        client.models.LocationLog.create(input),
        LOCATION_LOG_CREATE_TIMEOUT_MS,
        "Background LocationLog.create retry",
    );

    return {
        result: retryResult,
        authRefreshAttempted: true,
        authRefreshSucceeded: true,
    };
}

const BACKGROUND_QUEUE_MAINTENANCE_INTERVAL = 60;

/*
 * 起動後最初のcallbackでは、
 * 既存の大量な処理済みSQLiteレコードをcleanupする。
 *
 * 以降は60 callbackごとにcleanupする。
 */
let backgroundQueueMaintenanceCounter =
    BACKGROUND_QUEUE_MAINTENANCE_INTERVAL - 1;

/*
 * SQLite pendingのクラウド送信は、
 * 毎callbackではなく一定間隔で実行する。
 */
let lastBackgroundQueueDrainAtMs = 0;

const BACKGROUND_QUEUE_DRAIN_INTERVAL_MS = 15_000;

/*
 * Background LiveLocation のCloud更新間隔。
 *
 * Background callback自体は約5～7秒間隔で発生するが、
 * LiveLocationは現在地共有用のため毎callbackで更新せず、
 * 30秒に1回までに制限する。
 */
const BACKGROUND_LIVE_LOCATION_UPDATE_INTERVAL_MS = 30_000;

/*
 * このJS Runtime内で最後にLiveLocation更新を開始した時刻。
 *
 * single-flightは行わず、単純に更新頻度だけを抑制する。
 */
let lastBackgroundLiveLocationUpdateAtMs = 0;

const BACKGROUND_RUNTIME_BOOT_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

console.log("[BG_RUNTIME_BOOT]", {
    runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
    bootedAt: new Date().toISOString(),
});

/*
 * Headless JS keep-alive 中に、
 * JS setTimeout が本当に進み続けるか確認する一時診断。
 *
 * 同一JS Runtimeでは最初のBackground callbackで1回だけ実行する。
 */
let hasRunBackgroundKeepAliveTimerTest = false;

TaskManager.defineTask(
    BACKGROUND_LOCATION_TASK_NAME,
    async ({ data, error, executionInfo }) => {
        const taskStartedAtMs = Date.now();
        const taskFiredAt = new Date(taskStartedAtMs).toISOString();

        const eventId =
            executionInfo?.eventId ??
            `unknown-${taskStartedAtMs}-${Math.random().toString(36).slice(2)}`;

        const stageContext: BackgroundTaskStageContext = {
            eventId,
            taskName: executionInfo?.taskName ?? null,
            taskStartedAtMs,
        };

        console.log("[BG_TASK_ENTRY]", {
            runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
            eventId,
            taskName: executionInfo?.taskName ?? null,
            taskStartedAtMs,
            taskFiredAt,
        });

        recordBackgroundTaskStage(stageContext, "TASK_ENTRY");

        /*
         * Headless JS keep-alive中に
         * setTimeout(5000) が正常に進むか確認する。
         *
         * 同一JS Runtimeにつき1回だけ。
         */
        if (!hasRunBackgroundKeepAliveTimerTest) {
            hasRunBackgroundKeepAliveTimerTest = true;

            const timerTestScheduledAtMs = Date.now();
            const timerTestExpectedFireAtMs = timerTestScheduledAtMs + 5_000;

            recordBackgroundTaskStage(
                stageContext,
                "KEEPALIVE_TIMER_SCHEDULED",
                {
                    timerTestScheduledAtMs,
                    timerTestExpectedFireAtMs,
                },
            );

            console.log("[BG_KEEPALIVE_TIMER_TEST_SCHEDULED]", {
                runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
                eventId,
                scheduledAtMs: timerTestScheduledAtMs,
                scheduledAt: new Date(timerTestScheduledAtMs).toISOString(),
                expectedFireAtMs: timerTestExpectedFireAtMs,
                expectedFireAt: new Date(
                    timerTestExpectedFireAtMs,
                ).toISOString(),
            });

            /*
             * このtimer診断はawaitしない。
             */
            setTimeout(() => {
                const actuallyFiredAtMs = Date.now();

                console.log("[BG_KEEPALIVE_TIMER_TEST_FIRED]", {
                    runtimeBootId: BACKGROUND_RUNTIME_BOOT_ID,
                    eventId,
                    scheduledAtMs: timerTestScheduledAtMs,
                    expectedFireAtMs: timerTestExpectedFireAtMs,
                    actuallyFiredAtMs,
                    actuallyFiredAt: new Date(actuallyFiredAtMs).toISOString(),
                    timerDriftMs: actuallyFiredAtMs - timerTestExpectedFireAtMs,
                    actualElapsedMs: actuallyFiredAtMs - timerTestScheduledAtMs,
                });
            }, 5_000);
        }
        /*
         * 後続処理より前に、OSから渡された地点数を取得する。
         *
         * LocationLog保存や認証処理でエラーが発生した場合でも、
         * タスク自体が呼び出されたことをheartbeatで確認できるようにする。
         */
        const receivedLocations = (
            data as {
                locations?: Location.LocationObject[];
            }
        )?.locations;

        let locationsLength = receivedLocations?.length ?? 0;
        let saveSuccessCount = 0;
        let saveFailureCount = 0;

        let liveLocationUpdateAttempted = false;
        let liveLocationUpdateSucceeded = false;
        let liveLocationUpdateTimedOut = false;

        let liveLocationUpdateOperation: "none" | "create" | "update" = "none";

        let liveLocationUpdateErrorMessage: string | null = null;
        let liveLocationUpdatedId: string | null = null;

        let sqliteMirrorAttempted = false;
        let sqliteMirrorSucceeded = false;
        let sqliteMirrorDurationMs = 0;
        let sqliteMirrorInsertedCount = 0;
        let sqliteMirrorDuplicateCount = 0;
        let sqliteMirrorInvalidCount = 0;
        let sqliteMirrorPreExistingDuplicateCount = 0;
        let sqliteMirrorInsertAttemptCount = 0;
        /*
         * direct LocationLog保存へ実際に流す地点。
         *
         * SQLite mirrorを使わない場合やSQLite処理自体が失敗した場合は、
         * 従来どおり受信した全地点を使用する。
         */
        let locationsForDirectSave: Location.LocationObject[] | null = null;
        let sqliteMirrorQueueCount: number | null = null;
        let sqliteMirrorErrorMessage: string | null = null;
        let sqliteQueueUploadAttempted = false;
        let sqliteQueueUploadSucceeded = false;
        let sqliteQueueUploadDurationMs = 0;
        let sqliteQueueUploadPendingCount = 0;
        let sqliteQueueUploadProcessedCount = 0;
        let sqliteQueueUploadSentCount = 0;
        let sqliteQueueUploadDuplicateCount = 0;
        let sqliteQueueUploadSkippedCount = 0;
        let sqliteQueueUploadFailedCount = 0;
        let sqliteQueueUploadTimedOutCount = 0;
        let sqliteQueueUploadStopReason: string | null = null;
        let sqliteQueueUploadErrorMessage: string | null = null;
        let sqliteQueueTotalCount: number | null = null;
        let sqliteQueuePendingCount: number | null = null;
        let sqliteQueueSentStatusCount: number | null = null;
        let sqliteQueueDuplicateStatusCount: number | null = null;
        let sqliteQueueSkippedStatusCount: number | null = null;
        let sqliteQueueFailedPendingCount: number | null = null;
        let sqliteQueueOldestPendingRecordedAt: string | null = null;
        let sqliteQueueLatestPendingRecordedAt: string | null = null;
        let sqliteQueueSummaryErrorMessage: string | null = null;

        let invalidCoordinateSkippedCount = 0;
        let lowAccuracySkippedCount = 0;
        let abnormalSpeedSkippedCount = 0;
        let inProgressDuplicateSkippedCount = 0;
        let exactDuplicateSkippedCount = 0;
        let nearDuplicateSkippedCount = 0;
        let saveConditionSkippedCount = 0;

        let firstRecordedAt: string | null = null;
        let latestRecordedAt: string | null = null;

        const processingTimings = createBackgroundLocationProcessingTimings();

        let backgroundAuthSession: BackgroundAuthSessionResult | null = null;

        let backgroundAuthSessionDurationMs = 0;

        try {
            recordBackgroundTaskStage(stageContext, "STATE_LOAD_START");

            const state = await getBackgroundRecordingState();

            /*
             * Callbackが最初に読み取った共有世代を固定する。
             *
             * この後、別の処理がAsyncStorageを更新しても、
             * このCallbackのexpectedRevisionは変更しない。
             */
            const callbackShareRevision = state?.shareRevision;

            const callbackSharedOwners = Array.from(
                new Set((state?.liveShareOwnerValues ?? []).filter(Boolean)),
            );

            const callbackUserId = state?.userId ?? null;

            recordBackgroundTaskStage(stageContext, "STATE_LOAD_END", {
                hasState: Boolean(state),
                isRecording: state?.isRecording ?? false,
                recordingSessionId: state?.recordingSessionId ?? null,
            });

            recordBackgroundTaskStage(stageContext, "HEARTBEAT_SAVE_START", {
                locationsLength,
            });

            /*
             * LocationLog保存、SQLite処理、認証処理などより前にheartbeatを保存する。
             *
             * これにより、後続処理が失敗しても、
             * バックグラウンドタスク自体が起動したことを判定できる。
             */
            await safeSaveBackgroundLocationTaskHeartbeat({
                firedAt: taskStartedAtMs,
                taskFiredAt,
                locationsLength,
                recordingSessionId: state?.recordingSessionId ?? null,
                isRecording: state?.isRecording === true,
                userId: state?.userId ?? null,
                hasTaskError: Boolean(error),
            });

            recordBackgroundTaskStage(stageContext, "HEARTBEAT_SAVE_END");

            /*
             * TaskManagerからerrorが渡された場合は、
             * LocationLog処理へ進まず異常ログを1件だけ保存する。
             */
            if (error) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationTaskError",
                    taskFiredAt,
                    locationsLength,
                    saveSuccessCount,
                    saveFailureCount: 1,
                    errorMessage: getErrorMessage(error),
                    details: {
                        processingDurationMs: Date.now() - taskStartedAtMs,
                    },
                });

                console.error("Background location task error:", error);
                return;
            }

            const locations = receivedLocations;

            /*
             * 位置情報が0件の場合も、バッチ結果として1件だけ保存する。
             */
            if (!locations || locations.length === 0) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationBatchProcessed",
                    taskFiredAt,
                    locationsLength: 0,
                    saveSuccessCount: 0,
                    saveFailureCount: 0,
                    skippedCount: 0,
                    invalidCoordinateSkippedCount: 0,
                    lowAccuracySkippedCount: 0,
                    abnormalSpeedSkippedCount: 0,
                    inProgressDuplicateSkippedCount: 0,
                    exactDuplicateSkippedCount: 0,
                    nearDuplicateSkippedCount: 0,
                    saveConditionSkippedCount: 0,
                    details: {
                        batchStatus: "noLocations",
                        processingDurationMs: Date.now() - taskStartedAtMs,
                        firstRecordedAt: null,
                        latestRecordedAt: null,
                    },
                });

                return;
            }

            /*
             * 記録状態がない場合も、受信した地点数を残して終了する。
             */
            const activeRecordingSessionId =
                state?.isRecording === true && state.recordingSessionId
                    ? state.recordingSessionId
                    : null;

            const hasLiveSharing =
                (state?.liveShareOwnerValues?.length ?? 0) > 0;

            if (
                !state?.userId ||
                (!activeRecordingSessionId && !hasLiveSharing)
            ) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationBatchProcessed",
                    taskFiredAt,
                    locationsLength,
                    saveSuccessCount: 0,
                    saveFailureCount: 0,
                    skippedCount: locationsLength,
                    invalidCoordinateSkippedCount: 0,
                    lowAccuracySkippedCount: 0,
                    abnormalSpeedSkippedCount: 0,
                    inProgressDuplicateSkippedCount: 0,
                    exactDuplicateSkippedCount: 0,
                    nearDuplicateSkippedCount: 0,
                    saveConditionSkippedCount: 0,
                    details: {
                        batchStatus: "backgroundStateUnavailable",
                        processingDurationMs: Date.now() - taskStartedAtMs,
                        hasState: Boolean(state),
                        hasUserId: Boolean(state?.userId),
                        isRecording: state?.isRecording ?? false,
                        hasRecordingSessionId: Boolean(
                            state?.recordingSessionId,
                        ),
                        hasLiveSharing,
                        liveShareOwnerCount:
                            state?.liveShareOwnerValues?.length ?? 0,
                    },
                });

                console.log(
                    "Background recording or live sharing state not found.",
                );

                return;
            }

            /*
             * 第1段階：
             * OSから受信した全地点を、既存保存判定より前にSQLiteへ複製する。
             *
             * SQLite保存結果にかかわらず、
             * この後の既存LocationLog直接保存処理は必ず継続する。
             */
            if (ENABLE_LOCATION_SQLITE_MIRROR && activeRecordingSessionId) {
                sqliteMirrorAttempted = true;

                const sqliteMirrorStartedAtMs = Date.now();

                try {
                    recordBackgroundTaskStage(
                        stageContext,
                        "SQLITE_MIRROR_IMPORT_START",
                        {
                            locationsLength: locations.length,
                        },
                    );

                    const { enqueueLocationBatchForAudit } =
                        await import("../services/locationLocationQueueService");

                    recordBackgroundTaskStage(
                        stageContext,
                        "SQLITE_MIRROR_IMPORT_END",
                    );

                    recordBackgroundTaskStage(
                        stageContext,
                        "SQLITE_MIRROR_START",
                        {
                            locationsLength: locations.length,
                        },
                    );

                    const sqliteResult = await enqueueLocationBatchForAudit({
                        userId: state.userId,
                        recordingSessionId: activeRecordingSessionId,
                        source: "background",
                        locations,
                        receivedAt: taskFiredAt,
                        sharedOwners: state.liveShareOwnerValues,
                    });

                    recordBackgroundTaskStage(
                        stageContext,
                        "SQLITE_MIRROR_END",
                        {
                            insertedCount: sqliteResult.insertedCount,
                            preExistingDuplicateCount:
                                sqliteResult.preExistingDuplicateCount,
                            insertAttemptCount: sqliteResult.insertAttemptCount,
                            directSaveCount:
                                sqliteResult.locationsForDirectSave.length,
                        },
                    );

                    sqliteMirrorSucceeded = true;
                    sqliteMirrorInsertedCount = sqliteResult.insertedCount;
                    sqliteMirrorDuplicateCount = sqliteResult.duplicateCount;
                    sqliteMirrorInvalidCount = sqliteResult.invalidCount;
                    sqliteMirrorPreExistingDuplicateCount =
                        sqliteResult.preExistingDuplicateCount;
                    sqliteMirrorInsertAttemptCount =
                        sqliteResult.insertAttemptCount;
                    sqliteMirrorQueueCount = sqliteResult.queueCount;
                    /*
                     * SQLiteへ今回新規投入された地点、
                     * またはSQLite INSERT失敗でfallbackが必要な地点だけを
                     * direct LocationLog保存へ流す。
                     */
                    locationsForDirectSave =
                        sqliteResult.locationsForDirectSave;
                    console.log(
                        "Background SQLite location mirror completed:",
                        {
                            recordingSessionId: state.recordingSessionId,
                            receivedCount: sqliteResult.receivedCount,
                            preExistingDuplicateCount:
                                sqliteResult.preExistingDuplicateCount,
                            insertAttemptCount: sqliteResult.insertAttemptCount,
                            insertedCount: sqliteResult.insertedCount,
                            duplicateCount: sqliteResult.duplicateCount,
                            invalidCount: sqliteResult.invalidCount,
                            directSaveCount:
                                sqliteResult.locationsForDirectSave.length,
                            queueCount: sqliteResult.queueCount,
                        },
                    );
                } catch (sqliteError) {
                    sqliteMirrorErrorMessage = getErrorMessage(sqliteError);

                    /*
                     * 最重要：
                     * SQLite失敗時もreturnしない。
                     * 既存のLocationLog.create経路をそのまま継続する。
                     */
                    console.error(
                        "Background SQLite location mirror failed. Continue direct LocationLog save:",
                        sqliteError,
                    );
                } finally {
                    sqliteMirrorDurationMs =
                        Date.now() - sqliteMirrorStartedAtMs;
                }
            }

            if (activeRecordingSessionId) {
                /*
                 * SQLiteキューの集計・cleanupは、
                 * Background callbackごとには実行しない。
                 *
                 * 位置情報保存を優先し、
                 * maintenanceは一定callback数ごとにまとめて行う。
                 */
                backgroundQueueMaintenanceCounter += 1;

                if (
                    backgroundQueueMaintenanceCounter >=
                    BACKGROUND_QUEUE_MAINTENANCE_INTERVAL
                ) {
                    backgroundQueueMaintenanceCounter = 0;

                    try {
                        recordBackgroundTaskStage(
                            stageContext,
                            "QUEUE_MAINTENANCE_IMPORT_START",
                        );

                        const {
                            getLocationQueueStatusSummary,
                            cleanupProcessedLocationQueue,
                        } =
                            await import("../services/locationLocationQueueService");

                        recordBackgroundTaskStage(
                            stageContext,
                            "QUEUE_MAINTENANCE_IMPORT_END",
                        );

                        recordBackgroundTaskStage(
                            stageContext,
                            "QUEUE_SUMMARY_START",
                        );

                        const queueSummary =
                            await getLocationQueueStatusSummary({
                                userId: state.userId,
                                recordingSessionId: activeRecordingSessionId,
                            });

                        recordBackgroundTaskStage(
                            stageContext,
                            "QUEUE_SUMMARY_END",
                            {
                                totalCount: queueSummary.totalCount,
                                pendingCount: queueSummary.pendingCount,
                            },
                        );

                        sqliteQueueTotalCount = queueSummary.totalCount;
                        sqliteQueuePendingCount = queueSummary.pendingCount;
                        sqliteQueueSentStatusCount = queueSummary.sentCount;
                        sqliteQueueDuplicateStatusCount =
                            queueSummary.duplicateCount;
                        sqliteQueueSkippedStatusCount =
                            queueSummary.skippedCount;
                        sqliteQueueFailedPendingCount =
                            queueSummary.failedPendingCount;
                        sqliteQueueOldestPendingRecordedAt =
                            queueSummary.oldestPendingRecordedAt;
                        sqliteQueueLatestPendingRecordedAt =
                            queueSummary.latestPendingRecordedAt;

                        recordBackgroundTaskStage(
                            stageContext,
                            "QUEUE_CLEANUP_START",
                        );

                        const cleanupResult =
                            await cleanupProcessedLocationQueue({
                                retentionDays: 1,
                                maxProcessedRows: 2_000,
                            });

                        recordBackgroundTaskStage(
                            stageContext,
                            "QUEUE_CLEANUP_END",
                            {
                                deletedCount: cleanupResult.deletedCount,
                            },
                        );

                        if (cleanupResult.deletedCount > 0) {
                            console.log(
                                "Background SQLite queue cleanup completed:",
                                cleanupResult,
                            );
                        }
                    } catch (queueSummaryError) {
                        sqliteQueueSummaryErrorMessage =
                            getErrorMessage(queueSummaryError);

                        console.error(
                            "Background SQLite queue maintenance error:",
                            queueSummaryError,
                        );
                    }
                }
            }

            const backgroundAuthSessionStartedAtMs = Date.now();

            recordBackgroundTaskStage(stageContext, "AUTH_START");

            backgroundAuthSession = await prepareBackgroundAuthSession();

            recordBackgroundTaskStage(stageContext, "AUTH_END", {
                durationMs: Date.now() - backgroundAuthSessionStartedAtMs,
                available: backgroundAuthSession.available,
                refreshed: backgroundAuthSession.refreshed,
                hasIdToken: backgroundAuthSession.hasIdToken,
                hasAccessToken: backgroundAuthSession.hasAccessToken,
            });

            backgroundAuthSessionDurationMs =
                Date.now() - backgroundAuthSessionStartedAtMs;

            if (!backgroundAuthSession.available) {
                console.warn(
                    "Background auth session is not available before cloud location processing:",
                    {
                        recordingSessionId: state.recordingSessionId,
                        durationMs: backgroundAuthSessionDurationMs,
                        refreshed: backgroundAuthSession.refreshed,
                        hasIdToken: backgroundAuthSession.hasIdToken,
                        hasAccessToken: backgroundAuthSession.hasAccessToken,
                        errorMessage:
                            backgroundAuthSession.errorMessage ?? null,
                        isRecording: state.isRecording,
                        hasLiveSharing,
                    },
                );
            }
            /*
             * callbackでOSから受信した全地点。
             * DebugLogのfirst/latest算出用。
             */
            const sortedLocations = [...locations].sort((a, b) => {
                return getLocationRecordedAtMs(a) - getLocationRecordedAtMs(b);
            });

            firstRecordedAt = new Date(
                getLocationRecordedAtMs(sortedLocations[0]),
            ).toISOString();

            latestRecordedAt = new Date(
                getLocationRecordedAtMs(
                    sortedLocations[sortedLocations.length - 1],
                ),
            ).toISOString();

            /*
             * SQLite mirror成功時:
             *   今回新しくSQLiteへ入った地点だけをdirect保存する。
             *
             * SQLite mirror無効時:
             *   従来どおり全地点を処理する。
             *
             * SQLite mirror全体がtimeout / errorになった場合:
             *   locationsForDirectSaveはnullのままなので、
             *   従来どおり全地点へfallbackする。
             *
             * これによりSQLite障害による位置情報欠落は発生させない。
             */
            const directSaveLocations =
                ENABLE_LOCATION_SQLITE_MIRROR &&
                activeRecordingSessionId &&
                sqliteMirrorSucceeded &&
                locationsForDirectSave !== null
                    ? locationsForDirectSave
                    : locations;

            /*
             * direct LocationLog保存対象だけを時刻順に処理する。
             */
            const sortedDirectSaveLocations = [...directSaveLocations].sort(
                (a, b) => {
                    return (
                        getLocationRecordedAtMs(a) - getLocationRecordedAtMs(b)
                    );
                },
            );

            let currentState = state;

            /*
             * 最優先：
             * 今回OSから受信したLocationLogを先に保存する。
             *
             * LiveLocation更新がAndroidバックグラウンドで長時間停止しても、
             * 新しいLocationLogの保存を巻き込まないようにする。
             */
            if (
                KEEP_DIRECT_LOCATION_LOG_SAVE &&
                currentState.isRecording &&
                currentState.recordingSessionId
            ) {
                recordBackgroundTaskStage(
                    stageContext,
                    "DIRECT_SAVE_LOOP_START",
                    {
                        directSaveLocationsLength:
                            sortedDirectSaveLocations.length,
                    },
                );

                for (
                    let locationIndex = 0;
                    locationIndex < sortedDirectSaveLocations.length;
                    locationIndex += 1
                ) {
                    const location = sortedDirectSaveLocations[locationIndex];

                    recordBackgroundTaskStage(
                        stageContext,
                        "DIRECT_SAVE_LOCATION_START",
                        {
                            locationIndex,
                            locationCount: sortedDirectSaveLocations.length,
                            recordedAt: new Date(
                                getLocationRecordedAtMs(location),
                            ).toISOString(),
                        },
                    );

                    const result = await saveBackgroundLocation(
                        location,
                        currentState,
                        taskFiredAt,
                        processingTimings,
                    );

                    recordBackgroundTaskStage(
                        stageContext,
                        "DIRECT_SAVE_LOCATION_END",
                        {
                            locationIndex,
                            locationCount: sortedDirectSaveLocations.length,
                            saved: result.saved,
                            skippedReason: result.skippedReason ?? null,
                            hasError: Boolean(result.errorMessage),
                        },
                    );

                    if (result.saved) {
                        saveSuccessCount += 1;
                    }

                    if (result.errorMessage) {
                        saveFailureCount += 1;
                    }

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

                        case "planLimitReached":
                            /*
                             * Freeプラン上限による停止。
                             *
                             * 既存のskip集計には専用フィールドがないため、
                             * ここではsaveConditionSkippedCount等へ混ぜない。
                             */
                            break;

                        case undefined:
                            break;

                        default: {
                            const exhaustiveCheck: never = result.skippedReason;

                            console.warn(
                                "Unknown background location skip reason:",
                                exhaustiveCheck,
                            );
                        }
                    }

                    currentState = result.nextState;

                    /*
                     * Freeプラン上限によって記録終了状態になった場合は、
                     * 同じOSバッチ内の後続地点を処理しない。
                     *
                     * 1000件目保存後に1001件目へ進まないための防御。
                     */
                    if (!currentState.isRecording) {
                        console.log(
                            "[SubscriptionPlanLimit] Stop processing remaining background locations:",
                            {
                                recordingSessionId:
                                    currentState.recordingSessionId ?? null,
                            },
                        );

                        break;
                    }
                }
                recordBackgroundTaskStage(
                    stageContext,
                    "DIRECT_SAVE_LOOP_END",
                    {
                        saveSuccessCount,
                        saveFailureCount,
                    },
                );
            }

            /*
             * LocationLog保存完了後にLiveLocationを更新する。
             *
             * 現在地共有の機能自体は変更せず、
             * 実行順序だけLocationLogの後ろへ移動する。
             */
            const latestLocation = sortedLocations[sortedLocations.length - 1];

            if (
                latestLocation &&
                currentState.liveShareOwnerValues.length > 0
            ) {
                const nowMs = Date.now();

                const elapsedSinceLastLiveLocationUpdateMs =
                    nowMs - lastBackgroundLiveLocationUpdateAtMs;

                const shouldUpdateLiveLocation =
                    lastBackgroundLiveLocationUpdateAtMs === 0 ||
                    elapsedSinceLastLiveLocationUpdateMs >=
                        BACKGROUND_LIVE_LOCATION_UPDATE_INTERVAL_MS;

                if (shouldUpdateLiveLocation) {
                    /*
                     * update完了後ではなく、開始前に時刻を更新する。
                     *
                     * callbackが短時間に連続して入った場合でも、
                     * 30秒以内に次のLiveLocation.updateを開始しにくくする。
                     *
                     * これはsingle-flightではない。
                     * Promiseの完了状態は管理せず、単純な時間間隔制御のみ行う。
                     */
                    lastBackgroundLiveLocationUpdateAtMs = nowMs;

                    recordBackgroundTaskStage(
                        stageContext,
                        "LIVE_LOCATION_START",
                    );

                    const liveLocationResult =
                        await updateBackgroundLiveLocation(
                            latestLocation,
                            currentState,
                            taskFiredAt,
                            {
                                userId: callbackUserId,
                                revision: callbackShareRevision,
                                sharedOwners: callbackSharedOwners,
                            },
                        );

                    recordBackgroundTaskStage(
                        stageContext,
                        "LIVE_LOCATION_END",
                        {
                            attempted: liveLocationResult.attempted,
                            succeeded: liveLocationResult.succeeded,
                            timedOut: liveLocationResult.timedOut,
                            operation: liveLocationResult.operation,
                        },
                    );

                    currentState = liveLocationResult.nextState;
                    liveLocationUpdateAttempted = liveLocationResult.attempted;
                    liveLocationUpdateSucceeded = liveLocationResult.succeeded;
                    liveLocationUpdateTimedOut = liveLocationResult.timedOut;
                    liveLocationUpdateOperation = liveLocationResult.operation;
                    liveLocationUpdateErrorMessage =
                        liveLocationResult.errorMessage ?? null;
                    liveLocationUpdatedId =
                        liveLocationResult.liveLocationId ?? null;
                }
            }

            const nowMs = Date.now();

            /*
             * Expo / Android側から過去地点を含む大量batchが
             * 一度に再配送された場合は、
             *
             * ・SQLite mirror
             * ・direct LocationLog保存
             *
             * を優先する。
             *
             * SQLite queue uploadは後続callbackまたはForeground復帰時に
             * 実行できるため、このcallbackでは後回しにする。
             *
             * Raw地点やLocationLog候補を捨てる処理ではない。
             */
            const shouldDeferSQLiteQueueUpload =
                locations.length >= BACKGROUND_QUEUE_UPLOAD_DEFER_BATCH_SIZE;

            const shouldDrainSQLiteQueue =
                ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD &&
                Boolean(activeRecordingSessionId) &&
                currentState.isRecording &&
                !shouldDeferSQLiteQueueUpload &&
                nowMs - lastBackgroundQueueDrainAtMs >=
                    BACKGROUND_QUEUE_DRAIN_INTERVAL_MS;

            if (
                ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD &&
                activeRecordingSessionId &&
                currentState.isRecording &&
                shouldDeferSQLiteQueueUpload
            ) {
                console.log(
                    "Defer background SQLite queue upload for large batch:",
                    {
                        recordingSessionId: activeRecordingSessionId,
                        locationsLength: locations.length,
                        threshold: BACKGROUND_QUEUE_UPLOAD_DEFER_BATCH_SIZE,
                    },
                );
            }

            if (shouldDrainSQLiteQueue && activeRecordingSessionId) {
                /*
                 * ここで先に時刻を更新する。
                 *
                 * 同時期に複数callbackが来ても、
                 * 後続callbackから同じdrainを起動しにくくする。
                 */
                lastBackgroundQueueDrainAtMs = nowMs;

                sqliteQueueUploadAttempted = true;

                const queueUploadStartedAtMs = Date.now();

                try {
                    recordBackgroundTaskStage(
                        stageContext,
                        "QUEUE_UPLOAD_IMPORT_START",
                    );

                    const { drainLocationQueueSafely } =
                        await import("../services/locationQueueUploadService");

                    recordBackgroundTaskStage(
                        stageContext,
                        "QUEUE_UPLOAD_IMPORT_END",
                    );

                    recordBackgroundTaskStage(
                        stageContext,
                        "QUEUE_UPLOAD_START",
                    );

                    const uploadResult = await drainLocationQueueSafely({
                        userId: state.userId,
                        recordingSessionId: activeRecordingSessionId,
                        intervalMs: state.intervalMs,
                        distanceMeters: state.distanceMeters,
                        fallbackSharedOwners: state.liveShareOwnerValues,
                    });

                    recordBackgroundTaskStage(
                        stageContext,
                        "QUEUE_UPLOAD_END",
                        {
                            processedCount: uploadResult.processedCount,
                            sentCount: uploadResult.sentCount,
                            failedCount: uploadResult.failedCount,
                            timedOutCount: uploadResult.timedOutCount,
                            stopReason: uploadResult.stopReason,
                        },
                    );

                    /*
                     * alreadyRunningはクラウド送信エラーではない。
                     *
                     * 既存のdrainが動作中だったため、
                     * 今回のcallbackでは新しいdrainを開始しなかっただけ。
                     */
                    sqliteQueueUploadSucceeded =
                        uploadResult.failedCount === 0 &&
                        uploadResult.timedOutCount === 0;

                    sqliteQueueUploadPendingCount = uploadResult.pendingCount;

                    sqliteQueueUploadProcessedCount =
                        uploadResult.processedCount;

                    sqliteQueueUploadSentCount = uploadResult.sentCount;

                    sqliteQueueUploadDuplicateCount =
                        uploadResult.duplicateCount;

                    sqliteQueueUploadSkippedCount = uploadResult.skippedCount;

                    sqliteQueueUploadFailedCount = uploadResult.failedCount;

                    sqliteQueueUploadTimedOutCount = uploadResult.timedOutCount;

                    sqliteQueueUploadStopReason = uploadResult.stopReason;

                    console.log("SQLite location queue upload completed:", {
                        recordingSessionId: activeRecordingSessionId,
                        ...uploadResult,
                    });
                } catch (queueUploadError) {
                    sqliteQueueUploadErrorMessage =
                        getErrorMessage(queueUploadError);

                    console.error(
                        "SQLite location queue upload failed. Continue direct LocationLog save:",
                        queueUploadError,
                    );
                } finally {
                    sqliteQueueUploadDurationMs =
                        Date.now() - queueUploadStartedAtMs;
                }
            }

            const skippedCount =
                invalidCoordinateSkippedCount +
                lowAccuracySkippedCount +
                abnormalSpeedSkippedCount +
                inProgressDuplicateSkippedCount +
                exactDuplicateSkippedCount +
                nearDuplicateSkippedCount +
                saveConditionSkippedCount;

            const batchDebugLogStartedAt = new Date().toISOString();
            /*
             * LocationLog処理がすべて終わった後に、
             * バッチ全体のサマリを1件だけ保存する。
             *
             * デバッグログ保存関数内で例外は握りつぶされるため、
             * デバッグログ失敗がLocationLog処理を失敗させることはない。
             */

            /*
             * 追加：
             * BackgroundLocationDebugLog のCloud保存開始。
             *
             * このSTARTは出ているのにENDが出ない場合、
             * saveBackgroundLocationDebugLog() 内で停止していると判断できる。
             */
            recordBackgroundTaskStage(stageContext, "BATCH_DEBUG_LOG_START", {
                batchDebugLogStartedAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,
            });

            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
                eventName: "backgroundLocationBatchProcessed",
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
                details: {
                    batchStatus:
                        saveFailureCount > 0
                            ? "completedWithErrors"
                            : "completed",

                    /*
                     * バッチ結果ログの保存開始直前までの処理時間。
                     * このBackgroundLocationDebugLog自体の保存時間は含まれない。
                     */
                    processingDurationMs: Date.now() - taskStartedAtMs,
                    directSaveLocationsLength: sortedDirectSaveLocations.length,
                    sqliteMirrorEnabled: ENABLE_LOCATION_SQLITE_MIRROR,
                    sqliteMirrorAttempted,
                    sqliteMirrorSucceeded,
                    sqliteMirrorDurationMs,
                    sqliteMirrorInsertedCount,
                    sqliteMirrorDuplicateCount,
                    sqliteMirrorInvalidCount,
                    sqliteMirrorPreExistingDuplicateCount,
                    sqliteMirrorInsertAttemptCount,
                    sqliteMirrorQueueCount,
                    sqliteMirrorErrorMessage,
                    sqliteQueueUploadEnabled:
                        ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD,
                    keepDirectLocationLogSave: KEEP_DIRECT_LOCATION_LOG_SAVE,
                    sqliteQueueUploadDeferredForLargeBatch:
                        shouldDeferSQLiteQueueUpload,
                    sqliteQueueUploadDeferThreshold:
                        BACKGROUND_QUEUE_UPLOAD_DEFER_BATCH_SIZE,
                    sqliteQueueUploadAttempted,
                    sqliteQueueUploadSucceeded,
                    sqliteQueueUploadDurationMs,
                    sqliteQueueUploadPendingCount,
                    sqliteQueueUploadProcessedCount,
                    sqliteQueueUploadSentCount,
                    sqliteQueueUploadDuplicateCount,
                    sqliteQueueUploadSkippedCount,
                    sqliteQueueUploadFailedCount,
                    sqliteQueueUploadTimedOutCount,
                    sqliteQueueUploadStopReason,
                    sqliteQueueUploadErrorMessage,
                    sqliteQueueTotalCount,
                    sqliteQueuePendingCount,
                    sqliteQueueSentStatusCount,
                    sqliteQueueDuplicateStatusCount,
                    sqliteQueueSkippedStatusCount,
                    sqliteQueueFailedPendingCount,
                    sqliteQueueOldestPendingRecordedAt,
                    sqliteQueueLatestPendingRecordedAt,
                    sqliteQueueSummaryErrorMessage,

                    backgroundAuthSessionDurationMs,

                    backgroundAuthSessionAvailable:
                        backgroundAuthSession?.available ?? null,

                    backgroundAuthSessionRefreshed:
                        backgroundAuthSession?.refreshed ?? null,

                    backgroundAuthSessionHasIdToken:
                        backgroundAuthSession?.hasIdToken ?? null,

                    backgroundAuthSessionHasAccessToken:
                        backgroundAuthSession?.hasAccessToken ?? null,

                    backgroundAuthSessionErrorMessage:
                        backgroundAuthSession?.errorMessage ?? null,

                    batchDebugLogStartedAt,

                    firstRecordedAt,
                    latestRecordedAt,
                    intervalMs: state.intervalMs,
                    distanceMeters: state.distanceMeters,
                    isRecording: state.isRecording,

                    hasLiveShareOwners:
                        (state.liveShareOwnerValues?.length ?? 0) > 0,

                    liveShareOwnerCount:
                        state.liveShareOwnerValues?.length ?? 0,

                    /*
                     * LiveLocation更新結果
                     */
                    liveLocationUpdateAttempted,
                    liveLocationUpdateSucceeded,
                    liveLocationUpdateTimedOut,
                    liveLocationUpdateOperation,
                    liveLocationUpdateErrorMessage,
                    liveLocationUpdatedId,

                    /*
                     * 各処理のバッチ内合計時間
                     */
                    lockAcquireDurationMs:
                        processingTimings.lockAcquireDurationMs,

                    preCreateLookupDurationMs:
                        processingTimings.preCreateLookupDurationMs,

                    locationLogCreateDurationMs:
                        processingTimings.locationLogCreateDurationMs,

                    stateUpdateDurationMs:
                        processingTimings.stateUpdateDurationMs,

                    continuationUpdateDurationMs:
                        processingTimings.continuationUpdateDurationMs,

                    /*
                     * 各処理の実行回数
                     */
                    lockAcquireCount: processingTimings.lockAcquireCount,

                    preCreateLookupCount:
                        processingTimings.preCreateLookupCount,

                    locationLogCreateCount:
                        processingTimings.locationLogCreateCount,

                    stateUpdateCount: processingTimings.stateUpdateCount,

                    continuationUpdateCount:
                        processingTimings.continuationUpdateCount,

                    /*
                     * 各処理の1回あたり最大時間
                     */
                    lockAcquireMaxDurationMs:
                        processingTimings.lockAcquireMaxDurationMs,

                    preCreateLookupMaxDurationMs:
                        processingTimings.preCreateLookupMaxDurationMs,

                    locationLogCreateMaxDurationMs:
                        processingTimings.locationLogCreateMaxDurationMs,

                    stateUpdateMaxDurationMs:
                        processingTimings.stateUpdateMaxDurationMs,

                    continuationUpdateMaxDurationMs:
                        processingTimings.continuationUpdateMaxDurationMs,
                },
            });

            /*
             * 追加：
             * BackgroundLocationDebugLog 保存が戻ってきたことを示す。
             */
            recordBackgroundTaskStage(stageContext, "BATCH_DEBUG_LOG_END", {
                durationMs:
                    Date.now() - new Date(batchDebugLogStartedAt).getTime(),
            });
            /*
             * 追加：
             * tryブロック内の通常処理がすべて完了した。
             *
             * この後はTaskManager callbackからreturnするだけ。
             */
            recordBackgroundTaskStage(stageContext, "TASK_RETURNING", {
                processingDurationMs: Date.now() - taskStartedAtMs,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,
            });
        } catch (taskError) {
            /*
             * 追加：
             * try内で予期しない例外が発生した地点。
             */
            recordBackgroundTaskStage(stageContext, "TASK_ERROR", {
                errorMessage: getErrorMessage(taskError),
                processingDurationMs: Date.now() - taskStartedAtMs,
            });

            recordBackgroundTaskStage(
                stageContext,
                "UNEXPECTED_DEBUG_LOG_START",
                {
                    errorMessage: getErrorMessage(taskError),
                },
            );
            /*
             * 予期しない例外でも、ここまでの集計値を1件にまとめる。
             */
            await safeSaveBackgroundLocationDebugLog({
                eventName: "backgroundLocationTaskUnexpectedError",
                taskFiredAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount: saveFailureCount + 1,
                skippedCount:
                    invalidCoordinateSkippedCount +
                    lowAccuracySkippedCount +
                    abnormalSpeedSkippedCount +
                    inProgressDuplicateSkippedCount +
                    exactDuplicateSkippedCount +
                    nearDuplicateSkippedCount +
                    saveConditionSkippedCount,
                invalidCoordinateSkippedCount,
                lowAccuracySkippedCount,
                abnormalSpeedSkippedCount,
                inProgressDuplicateSkippedCount,
                exactDuplicateSkippedCount,
                nearDuplicateSkippedCount,
                saveConditionSkippedCount,
                errorMessage: getErrorMessage(taskError),
                details: {
                    batchStatus: "unexpectedError",

                    processingDurationMs: Date.now() - taskStartedAtMs,
                    /*
                     * LiveLocation更新結果
                     */
                    liveLocationUpdateAttempted,
                    liveLocationUpdateSucceeded,
                    liveLocationUpdateTimedOut,
                    liveLocationUpdateOperation,
                    liveLocationUpdateErrorMessage,
                    liveLocationUpdatedId,
                    /*
                     * SQLite複製保存の状態。
                     *
                     * SQLite処理中または処理後に予期しない例外が発生した場合でも、
                     * どこまでSQLite保存できていたかを確認できるようにする。
                     */
                    sqliteMirrorEnabled: ENABLE_LOCATION_SQLITE_MIRROR,
                    sqliteMirrorAttempted,
                    sqliteMirrorSucceeded,
                    sqliteMirrorDurationMs,
                    sqliteMirrorInsertedCount,
                    sqliteMirrorDuplicateCount,
                    sqliteMirrorInvalidCount,
                    sqliteMirrorQueueCount,
                    sqliteMirrorErrorMessage,
                    sqliteQueueUploadEnabled:
                        ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD,

                    keepDirectLocationLogSave: KEEP_DIRECT_LOCATION_LOG_SAVE,

                    sqliteQueueUploadAttempted,
                    sqliteQueueUploadSucceeded,
                    sqliteQueueUploadDurationMs,
                    sqliteQueueUploadPendingCount,
                    sqliteQueueUploadProcessedCount,
                    sqliteQueueUploadSentCount,
                    sqliteQueueUploadDuplicateCount,
                    sqliteQueueUploadSkippedCount,
                    sqliteQueueUploadFailedCount,
                    sqliteQueueUploadTimedOutCount,
                    sqliteQueueUploadStopReason,
                    sqliteQueueUploadErrorMessage,

                    sqliteQueueTotalCount,
                    sqliteQueuePendingCount,
                    sqliteQueueSentStatusCount,
                    sqliteQueueDuplicateStatusCount,
                    sqliteQueueSkippedStatusCount,
                    sqliteQueueFailedPendingCount,
                    sqliteQueueOldestPendingRecordedAt,
                    sqliteQueueLatestPendingRecordedAt,
                    sqliteQueueSummaryErrorMessage,

                    batchDebugLogStartedAt: new Date().toISOString(),

                    firstRecordedAt,
                    latestRecordedAt,

                    lockAcquireDurationMs:
                        processingTimings.lockAcquireDurationMs,

                    preCreateLookupDurationMs:
                        processingTimings.preCreateLookupDurationMs,

                    locationLogCreateDurationMs:
                        processingTimings.locationLogCreateDurationMs,

                    stateUpdateDurationMs:
                        processingTimings.stateUpdateDurationMs,

                    continuationUpdateDurationMs:
                        processingTimings.continuationUpdateDurationMs,

                    lockAcquireCount: processingTimings.lockAcquireCount,

                    preCreateLookupCount:
                        processingTimings.preCreateLookupCount,

                    locationLogCreateCount:
                        processingTimings.locationLogCreateCount,

                    stateUpdateCount: processingTimings.stateUpdateCount,

                    continuationUpdateCount:
                        processingTimings.continuationUpdateCount,

                    lockAcquireMaxDurationMs:
                        processingTimings.lockAcquireMaxDurationMs,

                    preCreateLookupMaxDurationMs:
                        processingTimings.preCreateLookupMaxDurationMs,

                    locationLogCreateMaxDurationMs:
                        processingTimings.locationLogCreateMaxDurationMs,

                    stateUpdateMaxDurationMs:
                        processingTimings.stateUpdateMaxDurationMs,

                    continuationUpdateMaxDurationMs:
                        processingTimings.continuationUpdateMaxDurationMs,
                },
            });

            recordBackgroundTaskStage(stageContext, "UNEXPECTED_DEBUG_LOG_END");

            console.error(
                "Background location task unexpected error:",
                taskError,
            );
        } finally {
            /*
             * try成功でもcatchでも必ず通る。
             *
             * これが出なければ、
             * どこかのawaitが返ってきていない可能性が高い。
             */
            recordBackgroundTaskStage(stageContext, "TASK_FINALLY", {
                totalDurationMs: Date.now() - taskStartedAtMs,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,
            });
        }
    },
);

function getLocationRecordedAtMs(location: Location.LocationObject): number {
    if (
        typeof location.timestamp === "number" &&
        Number.isFinite(location.timestamp)
    ) {
        return location.timestamp;
    }

    return Date.now();
}

async function getBackgroundRecordingState(): Promise<BackgroundRecordingState | null> {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<BackgroundRecordingState>;

        if (typeof parsed.userId !== "string" || parsed.userId.length === 0) {
            return null;
        }

        const liveShareOwnerValues = Array.isArray(parsed.liveShareOwnerValues)
            ? Array.from(
                  new Set(
                      parsed.liveShareOwnerValues.filter(
                          (value): value is string =>
                              typeof value === "string" && value.length > 0,
                      ),
                  ),
              )
            : [];

        return {
            /*
             * Service側が保存した追加項目も維持する。
             *
             * shareRevision、recordingExpiresAt、
             * liveSharingStartedAt等を、
             * Callback側の再保存で消さないため。
             */
            ...parsed,
            userId: parsed.userId,

            /*
             * 旧形式のデータにisRecordingがない場合は、
             * recordingSessionIdの有無から判定する。
             */
            isRecording:
                typeof parsed.isRecording === "boolean"
                    ? parsed.isRecording
                    : Boolean(parsed.recordingSessionId),

            recordingSessionId: parsed.recordingSessionId ?? null,

            startedAt: parsed.startedAt ?? null,

            liveShareOwnerValues,

            liveLocationId: parsed.liveLocationId ?? null,

            lastSavedLocation: parsed.lastSavedLocation ?? null,

            intervalMs:
                typeof parsed.intervalMs === "number" &&
                Number.isFinite(parsed.intervalMs) &&
                parsed.intervalMs > 0
                    ? parsed.intervalMs
                    : DEFAULT_INTERVAL_MS,

            distanceMeters:
                typeof parsed.distanceMeters === "number" &&
                Number.isFinite(parsed.distanceMeters) &&
                parsed.distanceMeters > 0
                    ? parsed.distanceMeters
                    : DEFAULT_DISTANCE_METERS,
        };
    } catch (error) {
        console.error("Parse background recording state error:", error);

        return null;
    }
}

async function getForegroundLastSavedLocation(): Promise<SavedLocation | null> {
    try {
        const raw = await AsyncStorage.getItem(
            FOREGROUND_LAST_SAVED_LOCATION_KEY,
        );

        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(raw) as Partial<SavedLocation>;

        if (
            typeof parsed.latitude !== "number" ||
            !Number.isFinite(parsed.latitude) ||
            typeof parsed.longitude !== "number" ||
            !Number.isFinite(parsed.longitude) ||
            typeof parsed.recordedAt !== "number" ||
            !Number.isFinite(parsed.recordedAt)
        ) {
            return null;
        }

        return {
            latitude: parsed.latitude,
            longitude: parsed.longitude,
            recordedAt: parsed.recordedAt,
        };
    } catch (error) {
        /*
         * Foreground側の最終保存地点が読めなくても、
         * Background記録そのものは止めない。
         */
        console.error("Read foreground lastSavedLocation error:", error);

        return null;
    }
}

function getLatestSavedLocation(
    backgroundLocation: SavedLocation | null,
    foregroundLocation: SavedLocation | null,
): SavedLocation | null {
    if (!backgroundLocation) {
        return foregroundLocation;
    }

    if (!foregroundLocation) {
        return backgroundLocation;
    }

    return foregroundLocation.recordedAt > backgroundLocation.recordedAt
        ? foregroundLocation
        : backgroundLocation;
}

async function updateBackgroundRecordingStateIfCurrent(
    expectedUserId: string,
    expectedRecordingSessionId: string | null,
    updater: (
        currentState: BackgroundRecordingState,
    ) => BackgroundRecordingState,
    expectedShareRevision?: number,
): Promise<BackgroundRecordingState | null> {
    const currentState = await getBackgroundRecordingState();

    if (!currentState) {
        return null;
    }

    /*
     * 1. ユーザー・RecordingSessionの一致確認。
     */
    if (
        currentState.userId !== expectedUserId ||
        (currentState.recordingSessionId ?? null) !== expectedRecordingSessionId
    ) {
        console.warn("[BackgroundRecordingState] Skip stale state update:", {
            expectedUserId,
            expectedRecordingSessionId,
            currentUserId: currentState.userId,
            currentRecordingSessionId: currentState.recordingSessionId ?? null,
        });

        return null;
    }

    /*
     * 2. 共有世代が指定されている場合は一致確認。
     *
     * LocationLog保存など、共有とは無関係の更新では
     * expectedShareRevisionを指定しない。
     */
    if (
        expectedShareRevision !== undefined &&
        currentState.shareRevision !== expectedShareRevision
    ) {
        console.warn(
            "[BackgroundRecordingState] Skip stale share revision update:",
            {
                expectedShareRevision,
                currentShareRevision: currentState.shareRevision ?? null,
                expectedRecordingSessionId,
            },
        );

        return null;
    }

    /*
     * 3. 既存の更新処理を実行。
     */
    const updatedState = updater(currentState);

    /*
     * 4. Callbackから共有設定を巻き戻さない。
     *
     * isRecordingやlastSavedLocationなど、
     * 既存の記録処理による変更は維持する。
     */
    const nextState: BackgroundRecordingState = {
        ...updatedState,

        userId: currentState.userId,
        recordingSessionId: currentState.recordingSessionId,

        liveShareOwnerValues: currentState.liveShareOwnerValues,

        shareRevision: currentState.shareRevision,
    };

    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );

    return nextState;
}

async function updateBackgroundLiveLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
    capturedSharing: {
        userId: string | null;
        revision: number | undefined;
        sharedOwners: string[];
    },
): Promise<UpdateBackgroundLiveLocationResult> {
    const sharedOwners = capturedSharing.sharedOwners;

    if (sharedOwners.length === 0) {
        return {
            nextState: state,
            attempted: false,
            succeeded: false,
            operation: "none",
            timedOut: false,
            liveLocationId: state.liveLocationId ?? null,
        };
    }

    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
            nextState: state,
            attempted: false,
            succeeded: false,
            operation: "none",
            timedOut: false,
            errorMessage: "LiveLocation coordinate is invalid.",
            liveLocationId: state.liveLocationId ?? null,
        };
    }

    const capturedShareRevision = capturedSharing.revision;

    if (
        capturedSharing.userId !== state.userId ||
        typeof capturedShareRevision !== "number" ||
        !Number.isSafeInteger(capturedShareRevision) ||
        capturedShareRevision < 1
    ) {
        console.warn("[LiveLocation] Background update skipped:", {
            reason: "INVALID_OR_STALE_SHARE_REVISION",
            capturedRevision: capturedShareRevision ?? null,
        });

        return {
            nextState: state,
            attempted: false,
            succeeded: false,
            operation: "none",
            timedOut: false,
            errorMessage: "INVALID_OR_STALE_SHARE_REVISION",
            liveLocationId: state.liveLocationId ?? null,
        };
    }

    const isRecording =
        state.isRecording === true && Boolean(state.recordingSessionId);

    try {
        // Callback開始時の古い共有設定で更新しないよう再確認
        const latestState = await getBackgroundRecordingState();

        /*
         * Callback開始時のユーザーと、
         * 現在のBackground状態のユーザーが一致することを確認。
         */
        if (
            !latestState ||
            latestState.userId !== capturedSharing.userId ||
            latestState.userId !== state.userId
        ) {
            throw new Error("BACKGROUND_LIVE_LOCATION_USER_CHANGED");
        }

        if (
            !latestState ||
            latestState.userId !== state.userId ||
            (latestState.recordingSessionId ?? null) !==
                (state.recordingSessionId ?? null) ||
            !Array.isArray(latestState.liveShareOwnerValues) ||
            latestState.liveShareOwnerValues.length === 0
        ) {
            return {
                nextState: latestState ?? state,
                attempted: false,
                succeeded: false,
                operation: "none",
                timedOut: false,
                liveLocationId: state.liveLocationId ?? null,
            };
        }

        const latestSharedOwners = Array.from(
            new Set(latestState.liveShareOwnerValues.filter(Boolean)),
        );

        const id = await withTimeout(
            upsertLiveLocation({
                userId: state.userId,
                latitude,
                longitude,
                accuracy: location.coords.accuracy ?? null,
                updatedAt: new Date().toISOString(),
                sharedOwners: latestSharedOwners,

                // Step 2で追加
                expectedRevision: capturedShareRevision,
            }),
            LIVE_LOCATION_UPDATE_TIMEOUT_MS,
            "Background LiveLocation.upsert",
        );

        const updatedState = await updateBackgroundRecordingStateIfCurrent(
            state.userId,
            state.recordingSessionId ?? null,
            (currentState) => ({
                ...currentState,
                liveLocationId: id,
            }),
            capturedShareRevision,
        );

        return {
            nextState: updatedState ?? latestState,
            attempted: true,
            succeeded: true,
            operation: "update",
            timedOut: false,
            liveLocationId: id,
        };
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        const timedOut = isOperationTimeoutError(error);

        console.error("Background LiveLocation upsert error:", error);

        // 既存のBackground Task診断に影響させない
        await safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId ?? null,
            eventName: timedOut
                ? "backgroundLiveLocationTimedOut"
                : "backgroundLiveLocationUnexpectedError",
            taskFiredAt,
            errorMessage,
            details: {
                latitude,
                longitude,
                isRecording,
                sharedOwnerCount: sharedOwners.length,
                timedOut,
            },
        });

        return {
            nextState: state,
            attempted: true,
            succeeded: false,
            operation: "update",
            timedOut,
            errorMessage,
            liveLocationId: state.liveLocationId ?? null,
        };
    }
}

async function saveBackgroundLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
    processingTimings: BackgroundLocationProcessingTimings,
): Promise<SaveBackgroundLocationResult> {
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
    const recordingSessionId = state.recordingSessionId;

    if (!recordingSessionId) {
        return {
            saved: false,
            nextState: state,
            errorMessage: "recordingSessionId is missing.",
        };
    }

    /*
     * Freeプランの1アクティビティ最大時間を確認する。
     *
     * accuracyや保存間隔の判定より前に実行することで、
     * 「移動していないためLocationLog保存条件を満たさない」
     * 場合でも2時間到達を検知できるようにする。
     */
    const durationLimitReason = await evaluateRecordingPlanDurationLimit(
        recordingSessionId,
        recordedAtMs,
    );

    if (durationLimitReason === "DURATION") {
        const stoppedState = await updateBackgroundRecordingStateIfCurrent(
            state.userId,
            recordingSessionId,
            (currentState) => ({
                ...currentState,
                isRecording: false,
            }),
        );

        /*
         * callback処理中に別sessionへ切り替わっていた場合、
         * 新しいsessionを停止しない。
         */
        if (!stoppedState) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "planLimitReached",
            };
        }

        console.log(
            "[SubscriptionPlanLimit] Background duration limit reached:",
            {
                recordingSessionId,
                recordedAt,
                reason: "DURATION",
            },
        );

        await safeSaveBackgroundLocationDebugLog({
            userId: stoppedState.userId,
            recordingSessionId,
            eventName: "backgroundRecordingPlanLimitReached",
            taskFiredAt,
            details: {
                reason: "DURATION",
                recordedAt,
            },
        });

        return {
            saved: false,
            nextState: stoppedState,
            skippedReason: "planLimitReached",
        };
    }

    if (isLowAccuracyLocation(accuracy)) {
        return {
            saved: false,
            nextState: state,
            skippedReason: "lowAccuracy",
        };
    }

    const lockScopeKey = createLocationSaveLockScopeKey(
        state.userId,
        recordingSessionId,
    );
    const lockAcquireStartedAtMs = Date.now();

    let lock: LocationSaveLock | null;

    try {
        lock = await acquireLocationSaveLock(lockScopeKey);
    } finally {
        const durationMs = Date.now() - lockAcquireStartedAtMs;

        processingTimings.lockAcquireDurationMs += durationMs;

        processingTimings.lockAcquireCount += 1;

        processingTimings.lockAcquireMaxDurationMs = Math.max(
            processingTimings.lockAcquireMaxDurationMs,
            durationMs,
        );
    }

    if (!lock) {
        return {
            saved: false,
            nextState: state,
            skippedReason: "inProgressDuplicate",
        };
    }

    /*
     * catch側でもPhase 3の予約結果を参照できるようにする。
     */
    let planLimitReservationReached = false;
    let planLimitLocationLogId: string | null = null;

    try {
        const latestState = await getBackgroundRecordingState();

        if (
            !latestState ||
            !latestState.isRecording ||
            latestState.recordingSessionId !== recordingSessionId
        ) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "saveConditionNotMet",
            };
        }

        /*
         * Foreground側で最後に保存成功した地点も取得する。
         */
        let foregroundLastSavedLocation =
            await getForegroundLastSavedLocation();

        /*
         * 新しい記録セッションより前のForeground保存地点は
         * 前回セッションのデータなので今回の基準には使わない。
         */
        if (foregroundLastSavedLocation && latestState.startedAt) {
            const sessionStartedAtMs = new Date(
                latestState.startedAt,
            ).getTime();

            if (
                Number.isFinite(sessionStartedAtMs) &&
                foregroundLastSavedLocation.recordedAt < sessionStartedAtMs
            ) {
                foregroundLastSavedLocation = null;
            }
        }

        /*
         * Background / Foregroundのうち、
         * recordedAtが新しい地点を保存判定の共通基準にする。
         */
        const lastSavedLocation = getLatestSavedLocation(
            latestState.lastSavedLocation ?? null,
            foregroundLastSavedLocation,
        );

        /*
         * 保存条件判定専用state。
         *
         * AsyncStorage上のBackground state自体はここでは書き換えず、
         * 保存判定時だけ共通の最新地点を使用する。
         */
        const evaluationState: BackgroundRecordingState = {
            ...latestState,
            lastSavedLocation,
        };

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
                userId: latestState.userId,
                recordingSessionId,
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
                nextState: latestState,
                skippedReason: "abnormalSpeed",
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
                nextState: latestState,
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
                nextState: latestState,
                skippedReason: "nearDuplicate",
            };
        }

        if (
            !shouldSaveLocation(
                latitude,
                longitude,
                recordedAtMs,
                evaluationState,
            )
        ) {
            return {
                saved: false,
                nextState: latestState,
                skippedReason: "saveConditionNotMet",
            };
        }

        const locationUniqueKey = createLocationUniqueKey({
            userId: latestState.userId,
            recordingSessionId,
            recordedAt,
            latitude,
            longitude,
            accuracy,
        });
        const locationLogId = createLocationLogId(locationUniqueKey);
        planLimitLocationLogId = locationLogId;
        /*
         * Freeプランのポイント上限を予約する。
         *
         * この処理はLocationSaveLock取得後に実行しているため、
         * Foreground / Backgroundが同時に1000件目を
         * 取得することを防止できる。
         */
        const reservation = await reserveRecordingPlanPoint(
            recordingSessionId,
            locationLogId,
            recordedAtMs,
        );

        if (!reservation.allowed) {
            const stoppedState = await updateBackgroundRecordingStateIfCurrent(
                latestState.userId,
                recordingSessionId,
                (currentState) => ({
                    ...currentState,
                    isRecording: false,
                }),
            );

            if (!stoppedState) {
                return {
                    saved: false,
                    nextState: latestState,
                    skippedReason: "planLimitReached",
                };
            }

            console.log(
                "[SubscriptionPlanLimit] Background point save blocked:",
                {
                    recordingSessionId,
                    locationLogId,
                    recordedAt,
                    reason: reservation.reason,
                    reservedPointCount:
                        reservation.state?.reservedLocationLogIds.length ??
                        null,
                },
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: stoppedState.userId,
                recordingSessionId,
                eventName: "backgroundRecordingPlanLimitReached",
                taskFiredAt,
                details: {
                    reason: reservation.reason ?? "POINTS",
                    locationLogId,
                    recordedAt,
                    reservedPointCount:
                        reservation.state?.reservedLocationLogIds.length ??
                        null,
                },
            });

            return {
                saved: false,
                nextState: stoppedState,
                skippedReason: "planLimitReached",
            };
        }

        const reservationCreated = !reservation.alreadyReserved;

        const reservationReachedLimit = reservation.reachedByThisReservation;

        planLimitReservationReached = reservationReachedLimit;
        /*
         * create前のLocationLog.getは実行しない。
         *
         * foreground/backgroundで共通の決定的idを使い、
         * 重複作成はLocationLog.createのエラーで判定する。
         */
        const sharedOwners =
            latestState.liveShareOwnerValues.length > 0
                ? Array.from(
                      new Set(latestState.liveShareOwnerValues.filter(Boolean)),
                  )
                : undefined;

        const locationLogCreateStartedAtMs = Date.now();

        let result: any;

        let authRefreshAttempted = false;
        let authRefreshSucceeded = false;

        try {
            const createResult = await createLocationLogWithAuthRetry({
                id: locationLogId,
                userId: latestState.userId,
                latitude,
                longitude,
                accuracy,
                recordedAt,
                memo: "自動記録",
                recordingSessionId,
                source: "background",
                sharedOwners,
                locationUniqueKey,
            });

            result = createResult.result;

            authRefreshAttempted = createResult.authRefreshAttempted;

            authRefreshSucceeded = createResult.authRefreshSucceeded;
        } finally {
            const durationMs = Date.now() - locationLogCreateStartedAtMs;

            processingTimings.locationLogCreateDurationMs += durationMs;

            processingTimings.locationLogCreateCount += 1;

            processingTimings.locationLogCreateMaxDurationMs = Math.max(
                processingTimings.locationLogCreateMaxDurationMs,
                durationMs,
            );
        }

        if (result.errors) {
            /*
             * 決定的なlocationLogIdによる重複作成だけを、
             * 正常な重複スキップとして扱う。
             *
             * 認証エラー、通信エラー、その他の作成エラーは
             * 重複扱いにせず、従来どおり保存失敗として記録する。
             */
            if (isDuplicateLocationCreateError(result.errors)) {
                /*
                 * Cloud上にはすでにこのLocationLogが存在するので、
                 * reservationは解除しない。
                 *
                 * 今回の予約によって1000件へ到達していた場合は、
                 * duplicateでもFree上限到達として記録を終了する。
                 */

                if (reservationReachedLimit) {
                    const stoppedState =
                        await updateBackgroundRecordingStateIfCurrent(
                            latestState.userId,
                            recordingSessionId,
                            (currentState) => ({
                                ...currentState,
                                isRecording: false,
                            }),
                        );

                    if (!stoppedState) {
                        return {
                            saved: false,
                            nextState: latestState,
                            skippedReason: "exactDuplicate",
                        };
                    }

                    console.log(
                        "[SubscriptionPlanLimit] Background point limit reached by duplicate:",
                        {
                            recordingSessionId,
                            locationLogId,
                            recordedAt,
                        },
                    );

                    await safeSaveBackgroundLocationDebugLog({
                        userId: stoppedState.userId,
                        recordingSessionId,
                        eventName: "backgroundRecordingPlanLimitReached",
                        taskFiredAt,
                        details: {
                            reason: "POINTS",
                            locationLogId,
                            recordedAt,
                            reservedPointCount:
                                reservation.state?.reservedLocationLogIds
                                    .length ?? null,
                        },
                    });

                    return {
                        saved: false,
                        nextState: stoppedState,
                        skippedReason: "exactDuplicate",
                    };
                }
            }

            /*
             * result.errorsとして明示的にcreate失敗した場合は、
             * Cloudへ保存されなかったと判断できるため
             * 今回新しく確保したreservationを戻す。
             */
            if (reservationCreated) {
                try {
                    await releaseRecordingPlanPointReservation(
                        recordingSessionId,
                        locationLogId,
                    );
                } catch (reservationReleaseError) {
                    console.error(
                        "[SubscriptionPlanLimit] Release background reservation error:",
                        reservationReleaseError,
                    );
                }
            }

            const errorMessage = getErrorMessage(result.errors);

            console.error(
                "Background LocationLog create errors:",
                result.errors,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: latestState.userId,
                recordingSessionId,
                eventName: "backgroundLocationLogCreateFailed",
                taskFiredAt,
                errorMessage,
                details: {
                    recordedAt,
                    latitude,
                    longitude,
                    locationUniqueKey,
                    authRefreshAttempted,
                    authRefreshSucceeded,
                    unauthorized: isUnauthorizedError(result.errors),
                },
            });

            return {
                saved: false,
                nextState: latestState,
                errorMessage,
            };
        }

        const stateUpdateStartedAtMs = Date.now();

        let nextState: BackgroundRecordingState = latestState;

        try {
            const updatedState = await updateBackgroundRecordingStateIfCurrent(
                latestState.userId,
                recordingSessionId,
                (currentState) => ({
                    ...currentState,

                    isRecording: reservationReachedLimit
                        ? false
                        : currentState.isRecording,

                    lastSavedLocation: {
                        latitude,
                        longitude,
                        recordedAt: recordedAtMs,
                    },
                }),
            );

            /*
             * LocationLog.create中に新しいsessionへ切り替わった場合、
             * 古いsessionのstateをAsyncStorageへ戻さない。
             */
            if (!updatedState) {
                console.warn(
                    "[BackgroundRecordingState] Skip stale LocationLog state update:",
                    {
                        recordingSessionId,
                        recordedAt,
                    },
                );

                return {
                    saved: true,
                    nextState: latestState,
                };
            }

            nextState = updatedState;

            if (reservationReachedLimit) {
                // 以下、既存処理
                //   if (reservationReachedLimit) {
                console.log(
                    "[SubscriptionPlanLimit] Background point limit reached:",
                    {
                        recordingSessionId,
                        locationLogId,
                        recordedAt,
                        reason: "POINTS",
                    },
                );

                await safeSaveBackgroundLocationDebugLog({
                    userId: latestState.userId,
                    recordingSessionId,
                    eventName: "backgroundRecordingPlanLimitReached",
                    taskFiredAt,
                    details: {
                        reason: "POINTS",
                        locationLogId,
                        recordedAt,
                        reservedPointCount:
                            reservation.state?.reservedLocationLogIds.length ??
                            null,
                    },
                });
            }
        } finally {
            const durationMs = Date.now() - stateUpdateStartedAtMs;

            processingTimings.stateUpdateDurationMs += durationMs;

            processingTimings.stateUpdateCount += 1;

            processingTimings.stateUpdateMaxDurationMs = Math.max(
                processingTimings.stateUpdateMaxDurationMs,
                durationMs,
            );
        }

        const continuationUpdateStartedAtMs = Date.now();

        try {
            await incrementRecordingContinuationPointCount(
                recordingSessionId,
                Date.now(),
                {
                    startConfirmationTimeout: false,
                },
            );
        } finally {
            const durationMs = Date.now() - continuationUpdateStartedAtMs;

            processingTimings.continuationUpdateDurationMs += durationMs;

            processingTimings.continuationUpdateCount += 1;

            processingTimings.continuationUpdateMaxDurationMs = Math.max(
                processingTimings.continuationUpdateMaxDurationMs,
                durationMs,
            );
        }

        return {
            saved: true,
            nextState,
        };
    } catch (error) {
        /*
         * LocationLog.create()が重複をresult.errorsではなく
         * 例外としてthrowした場合も、正常な重複スキップとして扱う。
         *
         * errorMessageを返さないため、バッチのsaveFailureCountには
         * 加算されず、exactDuplicateSkippedCountへ加算される。
         */
        if (isOperationTimeoutError(error)) {
            const errorMessage = getErrorMessage(error);

            console.warn("Background LocationLog create timed out:", {
                recordingSessionId,
                recordedAt,
                latitude,
                longitude,
                operationName: error.operationName,
                timeoutMs: error.timeoutMs,
                runtimeBootId: error.runtimeBootId,
                timerDriftMs: error.timerDriftMs,
                actualElapsedMs: error.actuallyFiredAtMs - error.scheduledAtMs,
            });

            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId,
                eventName: "backgroundLocationLogCreateTimedOut",
                taskFiredAt,
                errorMessage,
                details: {
                    recordedAt,
                    latitude,
                    longitude,

                    operationName: error.operationName,
                    timeoutMs: error.timeoutMs,

                    // PC非接続でも確認できるtimer診断情報
                    runtimeBootId: error.runtimeBootId,
                    scheduledAtMs: error.scheduledAtMs,
                    scheduledAt: new Date(error.scheduledAtMs).toISOString(),
                    expectedFireAtMs: error.expectedFireAtMs,
                    expectedFireAt: new Date(
                        error.expectedFireAtMs,
                    ).toISOString(),
                    actuallyFiredAtMs: error.actuallyFiredAtMs,
                    actuallyFiredAt: new Date(
                        error.actuallyFiredAtMs,
                    ).toISOString(),
                    timerDriftMs: error.timerDriftMs,
                    actualElapsedMs:
                        error.actuallyFiredAtMs - error.scheduledAtMs,

                    isRecording: state.isRecording,
                    isLiveSharing: state.liveShareOwnerValues.length > 0,
                    sharedOwnersCount: state.liveShareOwnerValues.length,
                },
            });

            /*
             * lastSavedLocationは更新しない。
             *
             * createが実際には遅れて成功する可能性があるため、
             * 次回は同じ決定的IDで再送され、
             * 成功済みなら重複として処理される。
             */
            return {
                saved: false,
                nextState: state,
                errorMessage,
            };
        }

        if (isDuplicateLocationCreateError(error)) {
            console.log(
                "Skip duplicate background LocationLog exception by deterministic id:",
                {
                    recordingSessionId,
                    locationLogId: planLimitLocationLogId,
                    recordedAt,
                    latitude,
                    longitude,
                },
            );

            /*
             * 1000件目としてreservation済みで、
             * createがduplicateをthrowした場合。
             *
             * Cloudには既に同じLocationLogが存在するため、
             * reservationは維持し、記録を終了状態にする。
             */
            if (planLimitReservationReached) {
                const latestState = await getBackgroundRecordingState();

                /*
                 * stateが既に削除されている、
                 * または別sessionへ切り替わっている場合は、
                 * 古いcallbackからstateを書き換えない。
                 */
                if (
                    !latestState ||
                    !latestState.isRecording ||
                    latestState.recordingSessionId !== recordingSessionId
                ) {
                    return {
                        saved: false,
                        nextState: state,
                        skippedReason: "planLimitReached",
                    };
                }

                const stoppedState =
                    await updateBackgroundRecordingStateIfCurrent(
                        latestState.userId,
                        recordingSessionId,
                        (currentState) => ({
                            ...currentState,
                            isRecording: false,
                        }),
                    );

                if (!stoppedState) {
                    return {
                        saved: false,
                        nextState: latestState,
                        skippedReason: "planLimitReached",
                    };
                }

                console.log(
                    "[SubscriptionPlanLimit] Background point limit reached by duplicate exception:",
                    {
                        recordingSessionId,
                        locationLogId: planLimitLocationLogId,
                        recordedAt,
                        reason: "POINTS",
                    },
                );

                return {
                    saved: false,
                    nextState: stoppedState,
                    skippedReason: "exactDuplicate",
                };
            }

            return {
                saved: false,
                nextState: state,
                skippedReason: "exactDuplicate",
            };
        }

        const errorMessage = getErrorMessage(error);

        console.error("saveBackgroundLocation unexpected error:", error);

        await safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId,
            eventName: "saveBackgroundLocationUnexpectedError",
            taskFiredAt,
            errorMessage,
            details: {
                isRecording: state.isRecording,
                isLiveSharing: state.liveShareOwnerValues.length > 0,
                sharedOwnersCount: state.liveShareOwnerValues.length,
                hasLiveLocationId: Boolean(state.liveLocationId),
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
        try {
            await withTimeout(
                releaseLocationSaveLock(lock),
                3_000,
                "Background location save lock release",
            );
        } catch (releaseError) {
            console.error(
                "Release background location save lock failed:",
                releaseError,
            );
        }
    }
}

const DEFAULT_DISTANCE_METERS = 50;
const DEFAULT_INTERVAL_MS = 30_000;

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

/**
 * 過去版で無制限に蓄積された
 * Background task stage診断キーを一度だけ削除する。
 *
 * この関数はAuthenticator表示前のアプリ起動時に呼び出す。
 *
 * 削除対象：
 *   location-tracker-background-location-task-stage:*
 *
 * 削除しないもの：
 *   - Background recording state
 *   - heartbeat
 *   - Location SQLite queue
 *   - LocationLog
 *   - Cognito認証情報
 *   - その他のAsyncStorageデータ
 */
export async function cleanupLegacyBackgroundTaskStageDiagnosticsOnce(): Promise<void> {
    let cleanupCompletedVersion: string | null = null;

    /*
     * AsyncStorage DBが既に上限付近の場合、
     * getItem自体が失敗する可能性がある。
     *
     * その場合でもcleanupを諦めず、
     * stageキー削除へ進む。
     */
    try {
        cleanupCompletedVersion = await AsyncStorage.getItem(
            BACKGROUND_LOCATION_TASK_STAGE_CLEANUP_VERSION_KEY,
        );
    } catch (versionReadError) {
        console.warn(
            "[BG_TASK_STAGE_LEGACY_CLEANUP_VERSION_READ_FAILED]",
            versionReadError,
        );
    }

    if (
        cleanupCompletedVersion ===
        BACKGROUND_LOCATION_TASK_STAGE_CLEANUP_VERSION
    ) {
        return;
    }

    try {
        const allKeys = await AsyncStorage.getAllKeys();

        const stageKeys = allKeys.filter((key) =>
            key.startsWith(BACKGROUND_LOCATION_TASK_STAGE_PREFIX),
        );

        /*
         * 完了マーカーを書き込む前に、
         * まず容量を圧迫しているstageキーを削除する。
         */
        if (stageKeys.length > 0) {
            await removeAsyncStorageKeysInBatches(stageKeys);
        }

        /*
         * stageキー削除後にcleanup完了マーカーを保存する。
         *
         * この保存だけ失敗した場合でも、
         * 次回起動時には再度cleanupが走るだけなので安全。
         */
        await AsyncStorage.setItem(
            BACKGROUND_LOCATION_TASK_STAGE_CLEANUP_VERSION_KEY,
            BACKGROUND_LOCATION_TASK_STAGE_CLEANUP_VERSION,
        );

        console.log("[BG_TASK_STAGE_LEGACY_CLEANUP_COMPLETED]", {
            removedCount: stageKeys.length,
            cleanupVersion: BACKGROUND_LOCATION_TASK_STAGE_CLEANUP_VERSION,
        });
    } catch (cleanupError) {
        /*
         * cleanup失敗だけでアプリを起動不能にはしない。
         *
         * cleanup-versionが保存されなければ、
         * 次回起動時に再試行される。
         */
        console.error("[BG_TASK_STAGE_LEGACY_CLEANUP_FAILED]", cleanupError);
    }
}
