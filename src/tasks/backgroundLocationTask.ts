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
  acquireLocationSaveLock,
  createLocationLogId,
  createLocationSaveLockScopeKey,
  createLocationUniqueKey,
  deduplicateLocationBatch,
  isDuplicateLocationCreateError,
  isLocationLogAlreadySaved,
  releaseLocationSaveLock,
} from "../services/locationLogDeduplicationService";
import {
  calculateDistanceMeters,
  calculateSpeedMetersPerSecond,
  isAbnormalSpeedLocation,
  isExactDuplicateLocation,
  isLowAccuracyLocation,
  isNearDuplicateLocation,
} from "../utils/locationDuplicate";

export const BACKGROUND_LOCATION_TASK_NAME =
  "location-tracker-background-location-task";

export const BACKGROUND_RECORDING_STATE_KEY =
  "location-tracker-background-recording-state";

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

  lastSavedLocation?: {
    latitude: number;
    longitude: number;
    recordedAt: number;
  } | null;

  intervalMs: number;
  distanceMeters: number;
};

type BackgroundLocationSkipReason =
  | "invalidCoordinate"
  | "lowAccuracy"
  | "abnormalSpeed"
  | "inProgressDuplicate"
  | "exactDuplicate"
  | "nearDuplicate"
  | "saveConditionNotMet";

type SaveBackgroundLocationResult = {
  saved: boolean;
  nextState: BackgroundRecordingState;
  skippedReason?: BackgroundLocationSkipReason;
  errorMessage?: string;
};

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

type BackgroundTaskInput = {
  data?: unknown;
  error?: unknown;
};

/*
 * OSから短時間に複数回バックグラウンドタスクが呼ばれた場合でも、
 * LocationLog保存・AsyncStorage更新・LiveLocation更新を直列に処理する。
 */
let backgroundLocationTaskQueue: Promise<void> = Promise.resolve();

TaskManager.defineTask(BACKGROUND_LOCATION_TASK_NAME, ({ data, error }) => {
  const queuedTask = backgroundLocationTaskQueue
    .catch((queueError) => {
      console.error(
        "Previous background location task queue error:",
        queueError,
      );
    })
    .then(() =>
      handleBackgroundLocationTask({
        data,
        error,
      }),
    );

  backgroundLocationTaskQueue = queuedTask;
  return queuedTask;
});

async function handleBackgroundLocationTask({
  data,
  error,
}: BackgroundTaskInput): Promise<void> {
  const taskFiredAt = new Date().toISOString();

  let locationsLength = 0;
  let uniqueLocationsLength = 0;
  let saveSuccessCount = 0;
  let saveFailureCount = 0;

  let skippedCount = 0;
  let invalidCoordinateSkippedCount = 0;
  let lowAccuracySkippedCount = 0;
  let abnormalSpeedSkippedCount = 0;
  let inProgressDuplicateSkippedCount = 0;
  let exactDuplicateSkippedCount = 0;
  let nearDuplicateSkippedCount = 0;
  let saveConditionSkippedCount = 0;

  let activeState: BackgroundRecordingState | null = null;

  try {
    const state = await getBackgroundRecordingState();

    /*
     * 自動記録中でも現在地共有中でもない場合は、
     * OSから遅れてタスクが呼ばれても
     * DebugLog・LocationLog・LiveLocationを作成／更新しない。
     */
    if (!isValidBackgroundRecordingState(state)) {
      console.log(
        "Background recording state not found. Skip background task.",
      );
      return;
    }

    activeState = state;

    if (error) {
      await safeSaveBackgroundLocationDebugLog({
        userId: state.userId,
        recordingSessionId: state.recordingSessionId,
        eventName: "backgroundLocationTaskError",
        taskFiredAt,
        errorMessage: getErrorMessage(error),
      });

      console.error("Background location task error:", error);
      return;
    }

    const locations = (
      data as { locations?: Location.LocationObject[] } | undefined
    )?.locations;

    locationsLength = locations?.length ?? 0;

    /*
     * 発火ログの保存完了を待たず、LocationLog処理を優先する。
     */
    void safeSaveBackgroundLocationDebugLog({
      userId: state.userId,
      recordingSessionId: state.recordingSessionId,
      eventName: "backgroundLocationTaskFired",
      taskFiredAt,
      locationsLength,
      details: {
        configuredIntervalMs: state.intervalMs,
        configuredDistanceMeters: state.distanceMeters,
      },
    });

    if (!locations || locations.length === 0) {
      await safeSaveBackgroundLocationDebugLog({
        userId: state.userId,
        recordingSessionId: state.recordingSessionId,
        eventName: "backgroundLocationTaskSkippedNoLocations",
        taskFiredAt,
        locationsLength,
        skippedCount: 1,
      });

      return;
    }

    const sortedLocations = [...locations].sort((a, b) => {
      const aTime =
        typeof a.timestamp === "number" && Number.isFinite(a.timestamp)
          ? a.timestamp
          : 0;

      const bTime =
        typeof b.timestamp === "number" && Number.isFinite(b.timestamp)
          ? b.timestamp
          : 0;

      return aTime - bTime;
    });

    /*
     * 1回のOS callback内に同一時刻・同一座標・同一精度の
     * LocationObjectが複数含まれていても1件だけ処理する。
     */
    const uniqueLocations = deduplicateLocationBatch(sortedLocations);
    uniqueLocationsLength = uniqueLocations.length;

    let currentState = state;

    /*
     * LocationLog保存を優先する。
     * LiveLocationはバッチ内の最新地点だけを最後に更新する。
     */
    for (const location of uniqueLocations) {
      if (!currentState.isRecording || !currentState.recordingSessionId) {
        continue;
      }

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

      if (result.skippedReason) {
        skippedCount += 1;

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
        }
      }

      currentState = result.nextState;
    }

    /*
     * LiveLocationはバッチ内の最新地点だけ更新する。
     */
    const latestLocation = uniqueLocations[uniqueLocations.length - 1];

    if (latestLocation) {
      currentState = await updateBackgroundLiveLocationState(
        latestLocation,
        currentState,
        taskFiredAt,
      );
    }

    await safeSaveBackgroundLocationDebugLog({
      userId: currentState.userId,
      recordingSessionId: currentState.recordingSessionId ?? null,
      eventName: "backgroundLocationTaskCompleted",
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
        uniqueLocationsLength,
        isRecording: currentState.isRecording,
        isLiveSharing: currentState.liveShareOwnerValues.length > 0,
        sharedOwnersCount: currentState.liveShareOwnerValues.length,
        hasLiveLocationId: Boolean(currentState.liveLocationId),
        configuredIntervalMs: currentState.intervalMs,
        configuredDistanceMeters: currentState.distanceMeters,
      },
    });
  } catch (taskError) {
    if (activeState) {
      await safeSaveBackgroundLocationDebugLog({
        userId: activeState.userId,
        recordingSessionId: activeState.recordingSessionId,
        eventName: "backgroundLocationTaskUnexpectedError",
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
        errorMessage: getErrorMessage(taskError),
        details: {
          uniqueLocationsLength,
          configuredIntervalMs: activeState.intervalMs,
          configuredDistanceMeters: activeState.distanceMeters,
        },
      });
    }

    console.error("Background location task unexpected error:", taskError);
  }
}

async function updateBackgroundLiveLocationState(
  location: Location.LocationObject,
  state: BackgroundRecordingState,
  taskFiredAt: string,
): Promise<BackgroundRecordingState> {
  const sharedOwners = Array.from(
    new Set((state.liveShareOwnerValues ?? []).filter(Boolean)),
  );

  if (sharedOwners.length === 0) {
    return state;
  }

  const latitude = location.coords.latitude;
  const longitude = location.coords.longitude;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return state;
  }

  const liveLocationModel = client.models.LiveLocation as any;

  const payload = {
    userId: state.userId,
    recordingSessionId: state.isRecording
      ? (state.recordingSessionId ?? null)
      : null,
    isRecording: state.isRecording,
    latitude,
    longitude,
    accuracy: location.coords.accuracy ?? null,
    updatedAt: new Date().toISOString(),
    isActive: true,
    sharedOwners,
  };

  let liveLocationId = state.liveLocationId ?? null;

  if (liveLocationId) {
    const result = await liveLocationModel.update({
      id: liveLocationId,
      ...payload,
    });

    if (result.errors) {
      await safeSaveBackgroundLocationDebugLog({
        userId: state.userId,
        recordingSessionId: state.recordingSessionId ?? null,
        eventName: "backgroundLiveLocationUpdateFailed",
        taskFiredAt,
        errorMessage: getErrorMessage(result.errors),
      });

      return state;
    }
  } else {
    const result = await liveLocationModel.create(payload);

    if (result.errors) {
      await safeSaveBackgroundLocationDebugLog({
        userId: state.userId,
        recordingSessionId: state.recordingSessionId ?? null,
        eventName: "backgroundLiveLocationCreateFailed",
        taskFiredAt,
        errorMessage: getErrorMessage(result.errors),
      });

      return state;
    }

    liveLocationId = result.data?.id ?? null;
  }

  const nextState: BackgroundRecordingState = {
    ...state,
    liveLocationId,
  };

  await setBackgroundRecordingState(nextState);

  return nextState;
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

function isValidBackgroundRecordingState(
  state: BackgroundRecordingState | null,
): state is BackgroundRecordingState {
  if (!state?.userId) {
    return false;
  }

  const isSharing =
    Array.isArray(state.liveShareOwnerValues) &&
    state.liveShareOwnerValues.length > 0;

  const hasRecordingSession =
    state.isRecording && Boolean(state.recordingSessionId);

  return isSharing || hasRecordingSession;
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
  const lock = await acquireLocationSaveLock(lockScopeKey);

  if (!lock) {
    return {
      saved: false,
      nextState: state,
      skippedReason: "inProgressDuplicate",
    };
  }

  try {
    /*
     * ロック取得後にAsyncStorageを再読込する。
     * foreground側が直前に保存したlastSavedLocationもここで反映する。
     */
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

    const lastSavedLocation = latestState.lastSavedLocation ?? null;

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
            speedMetersPerSecond == null ? null : speedMetersPerSecond * 3.6,
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

    const saveCondition = evaluateLocationSaveCondition(
      latitude,
      longitude,
      recordedAtMs,
      latestState,
    );

    if (!saveCondition.shouldSave) {
      void safeSaveBackgroundLocationDebugLog({
        userId: latestState.userId,
        recordingSessionId,
        eventName: "backgroundLocationSaveConditionNotMet",
        taskFiredAt,
        details: {
          recordedAt,
          latitude,
          longitude,
          accuracy,
          elapsedMs: saveCondition.elapsedMs,
          distanceFromLastSavedMeters:
            saveCondition.distanceFromLastSavedMeters,
          configuredIntervalMs: saveCondition.configuredIntervalMs,
          configuredDistanceMeters: saveCondition.configuredDistanceMeters,
          lastSavedRecordedAt:
            latestState.lastSavedLocation?.recordedAt ?? null,
        },
      });

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

    /*
     * 通常はここで既存レコードを検出する。
     * 同時実行でこの確認をすり抜けても、決定的idによりcreate時に防止される。
     */
    if (await isLocationLogAlreadySaved(locationLogId)) {
      return {
        saved: false,
        nextState: latestState,
        skippedReason: "exactDuplicate",
      };
    }

    const sharedOwners =
      latestState.liveShareOwnerValues.length > 0
        ? Array.from(new Set(latestState.liveShareOwnerValues.filter(Boolean)))
        : undefined;

    const result = await client.models.LocationLog.create({
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

    if (result.errors) {
      if (
        isDuplicateLocationCreateError(result.errors) ||
        (await isLocationLogAlreadySaved(locationLogId))
      ) {
        return {
          saved: false,
          nextState: latestState,
          skippedReason: "exactDuplicate",
        };
      }

      const errorMessage = getErrorMessage(result.errors);

      console.error("Background LocationLog create errors:", result.errors);

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
        },
      });

      return {
        saved: false,
        nextState: latestState,
        errorMessage,
      };
    }

    const nextState: BackgroundRecordingState = {
      ...latestState,
      lastSavedLocation: {
        latitude,
        longitude,
        recordedAt: recordedAtMs,
      },
    };

    /*
     * create成功からロック解放までの間に最終保存位置を更新する。
     */
    await setBackgroundRecordingState(nextState);

    return {
      saved: true,
      nextState,
    };
  } catch (error) {
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
        errorStack: error instanceof Error ? (error.stack ?? null) : null,
      },
    });

    return {
      saved: false,
      nextState: state,
      errorMessage,
    };
  } finally {
    await releaseLocationSaveLock(lock);
  }
}

const DEFAULT_DISTANCE_METERS = 50;
const DEFAULT_INTERVAL_MS = 30_000;

type LocationSaveConditionEvaluation = {
  shouldSave: boolean;
  elapsedMs: number | null;
  distanceFromLastSavedMeters: number | null;
  configuredIntervalMs: number;
  configuredDistanceMeters: number;
};

function evaluateLocationSaveCondition(
  latitude: number,
  longitude: number,
  recordedAtMs: number,
  state: BackgroundRecordingState,
): LocationSaveConditionEvaluation {
  const configuredIntervalMs =
    Number.isFinite(state.intervalMs) && state.intervalMs > 0
      ? state.intervalMs
      : DEFAULT_INTERVAL_MS;

  const configuredDistanceMeters =
    Number.isFinite(state.distanceMeters) && state.distanceMeters > 0
      ? state.distanceMeters
      : DEFAULT_DISTANCE_METERS;

  const lastSavedLocation = state.lastSavedLocation;

  if (!lastSavedLocation) {
    return {
      shouldSave: true,
      elapsedMs: null,
      distanceFromLastSavedMeters: null,
      configuredIntervalMs,
      configuredDistanceMeters,
    };
  }

  const elapsedMs = recordedAtMs - lastSavedLocation.recordedAt;

  if (elapsedMs <= 0) {
    return {
      shouldSave: false,
      elapsedMs,
      distanceFromLastSavedMeters: null,
      configuredIntervalMs,
      configuredDistanceMeters,
    };
  }

  const distanceFromLastSavedMeters = calculateDistanceMeters(
    lastSavedLocation.latitude,
    lastSavedLocation.longitude,
    latitude,
    longitude,
  );

  return {
    shouldSave:
      elapsedMs >= configuredIntervalMs ||
      distanceFromLastSavedMeters >= configuredDistanceMeters,
    elapsedMs,
    distanceFromLastSavedMeters,
    configuredIntervalMs,
    configuredDistanceMeters,
  };
}
