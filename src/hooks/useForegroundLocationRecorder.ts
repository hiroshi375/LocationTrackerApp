import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState } from "react-native";

import * as Battery from "expo-battery";
import { client } from "../lib/client";
import {
  ensureBackgroundLocationPermission,
  getBackgroundLocationTaskHealth,
  getBackgroundRecordingStatus,
  hasBackgroundTaskHeartbeatAfter,
  isBackgroundLocationDisclosureDeclined,
  isBackgroundLocationPermissionError,
  isForegroundLocationPermissionError,
  repairBackgroundLocationTaskForCurrentRecording,
  startBackgroundLocationRecording,
  stopBackgroundLocationRecording,
  updateBackgroundRecordingLiveLocationId,
  updateForegroundLastSavedLocation,
} from "../services/backgroundLocationService";
import {
  createLocationLogId,
  createLocationUniqueKey,
  isDuplicateLocationCreateError,
} from "../services/locationLogDeduplicationService";
import {
  confirmRecordingContinuation,
  evaluateRecordingContinuation,
  initializeRecordingContinuationState,
  markRecordingContinuationAutoStopped,
  type RecordingContinuationState,
} from "../services/recordingContinuationService";
import {
  calculateDistanceMeters,
  isExactDuplicateLocation,
  isNearDuplicateLocation,
} from "../utils/locationDuplicate";

type SavedLocation = {
  latitude: number;
  longitude: number;
  recordedAt: number;
};

type RecorderOptions = {
  intervalMs: number;
  distanceMeters: number;
  liveShareOwnerValues?: string[];
};

type StopRecordingOptions = {
  skipFinalLocationSave?: boolean;
};

type LiveLocationMutationResult = {
  data?: {
    id?: string | null;
  } | null;
  errors?: unknown;
};

export type BackgroundTaskRuntimeStatus =
  | "idle"
  | "checking"
  | "registered"
  | "running"
  | "repairing"
  | "error";

export function useForegroundLocationRecorder({
  intervalMs,
  distanceMeters,
  liveShareOwnerValues = [],
}: RecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<string | null>(
    null,
  );

  const lastSavedLocationRef = useRef<SavedLocation | null>(null);
  const savingLocationKeyRef = useRef<string | null>(null);
  const recordingSessionIdRef = useRef<string | null>(null);
  const recordingUserIdRef = useRef<string | null>(null);
  const liveLocationIdRef = useRef<string | null>(null);
  const foregroundQueueDrainRunningRef = useRef(false);
  const isRecordingRef = useRef(false);

  const recordingSubscriptionRef = useRef<Location.LocationSubscription | null>(
    null,
  );

  const liveSharingSubscriptionRef =
    useRef<Location.LocationSubscription | null>(null);

  const [continuationPrompt, setContinuationPrompt] =
    useState<RecordingContinuationState | null>(null);

  const [autoStoppedSessionId, setAutoStoppedSessionId] = useState<
    string | null
  >(null);
  const [activeRecordingSessionId, setActiveRecordingSessionId] = useState<
    string | null
  >(null);

  const startLocationRef = useRef<{
    latitude: number;
    longitude: number;
  } | null>(null);

  const appStateRef = useRef(AppState.currentState);

  const [distanceFromStartMeters, setDistanceFromStartMeters] = useState<
    number | null
  >(null);

  const forceDistanceMeters = Math.max(distanceMeters * 5, 100);

  const [backgroundTaskStatus, setBackgroundTaskStatus] =
    useState<BackgroundTaskRuntimeStatus>("idle");

  const [backgroundTaskErrorMessage, setBackgroundTaskErrorMessage] = useState<
    string | null
  >(null);

  const backgroundEnteredAtRef = useRef<number | null>(null);

  const backgroundRepairAttemptedRef = useRef(false);

  const normalizedLiveShareOwnerValues = useMemo(() => {
    return Array.from(new Set(liveShareOwnerValues.filter(Boolean)));
  }, [liveShareOwnerValues]);

  // 位置を保存すべきか判定する関数
  const shouldSaveLocation = useCallback(
    (latitude: number, longitude: number, recordedAtMs: number) => {
      if (!lastSavedLocationRef.current) {
        return true;
      }

      const elapsedMs = recordedAtMs - lastSavedLocationRef.current.recordedAt;

      if (elapsedMs <= 0) {
        return false;
      }

      const distance = calculateDistanceMeters(
        lastSavedLocationRef.current.latitude,
        lastSavedLocationRef.current.longitude,
        latitude,
        longitude,
      );

      //指定間隔未満なら保存しない
      if (elapsedMs < intervalMs && distance < forceDistanceMeters) {
        return false;
      }

      if (elapsedMs >= intervalMs) {
        return true;
      }

      //100m以上動いた場合は例外的に保存
      if (distance >= forceDistanceMeters) {
        return true;
      }

      return false;
    },
    [intervalMs, forceDistanceMeters],
  );

  //
  const updateDistanceFromStart = useCallback(
    (location: Location.LocationObject) => {
      const startLocation = startLocationRef.current;

      if (!startLocation) {
        return;
      }

      const currentLocation = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };

      const distance = calculateDistanceMeters(
        startLocation.latitude,
        startLocation.longitude,
        currentLocation.latitude,
        currentLocation.longitude,
      );

      setDistanceFromStartMeters(distance);
    },
    [],
  );

  //
  const updateLiveLocation = useCallback(
    async (location: Location.LocationObject) => {
      if (normalizedLiveShareOwnerValues.length === 0) {
        return;
      }

      const isCurrentlyRecording = isRecordingRef.current;

      const recordingSessionId = isCurrentlyRecording
        ? recordingSessionIdRef.current
        : null;

      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
      }

      try {
        const liveLocationModel = client.models.LiveLocation as any;

        const currentUser = await getCurrentUser();
        const updatedAt = new Date().toISOString();

        const payload = {
          userId: currentUser.userId,
          recordingSessionId,
          isActive: true,
          isRecording: isCurrentlyRecording,
          latitude,
          longitude,
          accuracy: location.coords.accuracy ?? null,
          updatedAt,
          sharedOwners: normalizedLiveShareOwnerValues,
        };

        if (liveLocationIdRef.current) {
          const result = (await liveLocationModel.update({
            id: liveLocationIdRef.current,
            ...payload,
          })) as LiveLocationMutationResult;

          if (result.errors) {
            console.error("LiveLocation update errors:", result.errors);
          }

          return;
        }

        const result = (await liveLocationModel.create(
          payload,
        )) as LiveLocationMutationResult;

        if (result.errors) {
          console.error("LiveLocation create errors:", result.errors);
          return;
        }

        liveLocationIdRef.current = result.data?.id ?? null;

        await updateBackgroundRecordingLiveLocationId(
          liveLocationIdRef.current,
        );
      } catch (error) {
        console.error("LiveLocation update error:", error);
      }
    },
    [normalizedLiveShareOwnerValues],
  );

  // 位置を保存する関数
  const saveLocationLog = useCallback(
    async (location: Location.LocationObject, forceSave: boolean = false) => {
      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
      }

      const recordingSessionId = recordingSessionIdRef.current;

      if (!recordingSessionId) {
        return;
      }

      const recordedAtMs =
        typeof location.timestamp === "number" &&
        Number.isFinite(location.timestamp)
          ? location.timestamp
          : Date.now();

      const recordedAt = new Date(recordedAtMs).toISOString();

      updateDistanceFromStart(location);

      const duplicateKey = createLocationDuplicateKey(
        latitude,
        longitude,
        recordedAtMs,
      );

      if (savingLocationKeyRef.current === duplicateKey) {
        return;
      }

      if (
        isExactDuplicateLocation(
          lastSavedLocationRef.current,
          latitude,
          longitude,
          recordedAtMs,
        ) ||
        isNearDuplicateLocation(
          lastSavedLocationRef.current,
          latitude,
          longitude,
          recordedAtMs,
        )
      ) {
        console.log("Skip duplicate foreground location:", {
          latitude,
          longitude,
          recordedAt,
        });

        return;
      }

      if (!forceSave) {
        try {
          const { state } = await getBackgroundRecordingStatus();

          const backgroundLastSavedLocation = state?.lastSavedLocation ?? null;

          if (
            isExactDuplicateLocation(
              backgroundLastSavedLocation,
              latitude,
              longitude,
              recordedAtMs,
            ) ||
            isNearDuplicateLocation(
              backgroundLastSavedLocation,
              latitude,
              longitude,
              recordedAtMs,
            )
          ) {
            console.log(
              "Skip duplicate foreground location by background state:",
              {
                latitude,
                longitude,
                recordedAt,
              },
            );

            return;
          }
        } catch (error) {
          console.error("Check background duplicate location error:", error);
        }
      }

      if (
        !forceSave &&
        !shouldSaveLocation(latitude, longitude, recordedAtMs)
      ) {
        return;
      }

      try {
        savingLocationKeyRef.current = duplicateKey;

        const currentUser = await getCurrentUser();

        const batterySnapshot = await getBatterySnapshot();

        const sharedOwners =
          normalizedLiveShareOwnerValues.length > 0
            ? normalizedLiveShareOwnerValues
            : undefined;

        const accuracy = location.coords.accuracy ?? null;

        const locationUniqueKey = createLocationUniqueKey({
          userId: currentUser.userId,
          recordingSessionId,
          recordedAt,
          latitude,
          longitude,
          accuracy,
        });

        const locationLogId = createLocationLogId(locationUniqueKey);

        const result = await client.models.LocationLog.create({
          id: locationLogId,

          userId: currentUser.userId,
          latitude,
          longitude,
          accuracy,
          recordedAt,
          memo: "自動記録",
          recordingSessionId,
          source: "foreground",

          sharedOwners,
          locationUniqueKey,

          batteryLevel: batterySnapshot.batteryLevel ?? undefined,
          batteryState: batterySnapshot.batteryState ?? undefined,
          lowPowerMode: batterySnapshot.lowPowerMode ?? undefined,
        });

        if (result.errors) {
          /*
           * 同じIDがすでに存在する場合は、
           * foreground/background間の重複を正常に防止できたと判断する。
           */
          if (isDuplicateLocationCreateError(result.errors)) {
            console.log(
              "Skip duplicate foreground LocationLog by deterministic id:",
              {
                locationLogId,
                recordingSessionId,
                recordedAt,
                latitude,
                longitude,
              },
            );

            return;
          }

          console.error("Auto LocationLog create errors:", result.errors);

          return;
        }

        const nextSavedLocation = {
          latitude,
          longitude,
          recordedAt: recordedAtMs,
        };

        lastSavedLocationRef.current = nextSavedLocation;

        await updateForegroundLastSavedLocation(nextSavedLocation);

        console.log("Auto location saved:", {
          latitude,
          longitude,
          recordedAt,
        });
      } catch (error) {
        if (isDuplicateLocationCreateError(error)) {
          console.log(
            "Skip duplicate foreground LocationLog exception by deterministic id:",
            {
              recordingSessionId,
              recordedAt,
              latitude,
              longitude,
            },
          );

          return;
        }

        console.error("Auto LocationLog create error:", error);
      } finally {
        if (savingLocationKeyRef.current === duplicateKey) {
          savingLocationKeyRef.current = null;
        }
      }
    },
    [
      shouldSaveLocation,
      updateDistanceFromStart,
      normalizedLiveShareOwnerValues,
    ],
  );

  const resetRecordingState = useCallback(() => {
    recordingSubscriptionRef.current?.remove();
    recordingSubscriptionRef.current = null;

    if (normalizedLiveShareOwnerValues.length === 0) {
      liveLocationIdRef.current = null;
    }
    recordingSessionIdRef.current = null;
    recordingUserIdRef.current = null;
    startLocationRef.current = null;
    lastSavedLocationRef.current = null;
    isRecordingRef.current = false;

    setActiveRecordingSessionId(null);
    setRecordingStartedAt(null);
    setDistanceFromStartMeters(null);
    setIsRecording(false);
  }, [normalizedLiveShareOwnerValues]);

  const isStartingRef = useRef(false);

  const restoreRecordingState = useCallback(async () => {
    if (isRecording || isStartingRef.current) {
      return;
    }

    try {
      const { hasStarted, state } = await getBackgroundRecordingStatus();

      if (!hasStarted) {
        return;
      }

      if (!state?.recordingSessionId || !state.userId) {
        return;
      }

      const startedAtMs = state.startedAt
        ? new Date(state.startedAt).getTime()
        : Number.NaN;

      const maxRestoreAgeMs = 12 * 60 * 60 * 1000;

      const isExpired =
        !Number.isFinite(startedAtMs) ||
        Date.now() - startedAtMs > maxRestoreAgeMs;

      if (isExpired) {
        console.warn("Skip expired background recording state:", {
          recordingSessionId: state.recordingSessionId,
          startedAt: state.startedAt,
        });

        try {
          await stopBackgroundLocationRecording();
        } catch (error) {
          console.error(
            "Clear expired background recording state error:",
            error,
          );
        }

        resetRecordingState();
        return;
      }

      recordingSessionIdRef.current = state.recordingSessionId;
      recordingUserIdRef.current = state.userId;
      liveLocationIdRef.current = state.liveLocationId ?? null;
      lastSavedLocationRef.current = state.lastSavedLocation ?? null;
      isRecordingRef.current = true;
      setActiveRecordingSessionId(state.recordingSessionId);
      setRecordingStartedAt(state.startedAt ?? null);
      setDistanceFromStartMeters(null);
      setIsRecording(true);

      console.log("Restored background recording state:", {
        recordingSessionId: state.recordingSessionId,
        startedAt: state.startedAt,
      });
    } catch (error) {
      console.error("Restore recording state error:", error);
    }
  }, [isRecording, resetRecordingState]);

  // 記録開始関数
  const startRecording = useCallback(async () => {
    if (
      isRecording ||
      recordingSubscriptionRef.current ||
      isStartingRef.current
    ) {
      return;
    }

    isStartingRef.current = true;

    try {
      try {
        await ensureBackgroundLocationPermission();
      } catch (error) {
        const isExpectedPermissionResult =
          isBackgroundLocationDisclosureDeclined(error) ||
          isForegroundLocationPermissionError(error) ||
          isBackgroundLocationPermissionError(error);

        if (isExpectedPermissionResult) {
          /*
           * 事前説明のキャンセルや権限拒否は、
           * LocationHomeScreen側で判定するため呼び出し元へ返す。
           */
          throw error;
        }

        console.error("Location permission error:", error);

        /*
         * 画面側でエラーを表示するため、
         * このフック内ではAlertを表示しない。
         */
        throw error;
      }

      const newSessionId = createRecordingSessionId();

      recordingSessionIdRef.current = newSessionId;
      isRecordingRef.current = true;

      setContinuationPrompt(null);
      setAutoStoppedSessionId(null);

      setActiveRecordingSessionId(newSessionId);
      lastSavedLocationRef.current = null;

      const startedAt = new Date().toISOString();

      await initializeRecordingContinuationState(newSessionId, startedAt);

      setRecordingStartedAt(startedAt);

      let currentLocation: Location.LocationObject;

      try {
        currentLocation = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
      } catch (error) {
        resetRecordingState();

        console.error("Get current location error:", error);

        Alert.alert(
          "現在地を取得できませんでした",
          "位置情報サービスが有効になっているか確認してください。",
        );
        return;
      }

      const currentLocationRecordedAtMs =
        typeof currentLocation.timestamp === "number" &&
        Number.isFinite(currentLocation.timestamp)
          ? currentLocation.timestamp
          : Date.now();

      startLocationRef.current = {
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
      };

      setDistanceFromStartMeters(0);

      try {
        const currentUser = await getCurrentUser();
        recordingUserIdRef.current = currentUser.userId;

        await startBackgroundLocationRecording({
          userId: currentUser.userId,
          recordingSessionId: newSessionId,
          startedAt,
          recordingExpiresAt: null,
          intervalMs,
          distanceMeters,
          liveShareOwnerValues: normalizedLiveShareOwnerValues,
          liveLocationId: liveLocationIdRef.current,
          lastSavedLocation: {
            latitude: currentLocation.coords.latitude,
            longitude: currentLocation.coords.longitude,
            recordedAt: currentLocationRecordedAtMs,
          },
        });

        backgroundRepairAttemptedRef.current = false;
        setBackgroundTaskStatus("registered");
        setBackgroundTaskErrorMessage(null);
      } catch (error) {
        try {
          await stopBackgroundLocationRecording();
        } catch (stopError) {
          console.error("Stop background after start error:", stopError);
        }

        resetRecordingState();

        const isExpectedPermissionResult =
          isBackgroundLocationDisclosureDeclined(error) ||
          isForegroundLocationPermissionError(error) ||
          isBackgroundLocationPermissionError(error);

        if (isExpectedPermissionResult) {
          /*
           * 想定された権限関連の結果は、
           * LocationHomeScreen側へ返す。
           */
          throw error;
        }

        console.error("Start background location recording error:", error);

        /*
         * 画面側でエラーを表示するため、
         * このフック内ではAlertを表示しない。
         */
        throw error;
      }

      try {
        const subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: intervalMs,
            distanceInterval: distanceMeters,
          },
          async (location) => {
            if (appStateRef.current !== "active") {
              return;
            }

            /*
             * LiveLocation更新は共有専用watcherが担当する。
             */
            await saveLocationLog(location);
          },
        );

        recordingSubscriptionRef.current = subscription;
      } catch (error) {
        console.error("Foreground watch position start error:", error);

        // backgroundLocationRecording はすでに開始済みのため止めない。
        // foreground の watchPositionAsync に失敗しても、
        // background task による自動記録は継続させる。
      }

      isRecordingRef.current = true;
      setIsRecording(true);

      await updateLiveLocation(currentLocation);
      await updateBackgroundRecordingLiveLocationId(liveLocationIdRef.current);
      await saveLocationLog(currentLocation, true);
    } finally {
      isStartingRef.current = false;
    }
  }, [
    isRecording,
    saveLocationLog,
    updateLiveLocation,
    intervalMs,
    distanceMeters,
    normalizedLiveShareOwnerValues,
    resetRecordingState,
  ]);

  const drainSQLiteQueueOnForeground = useCallback(async (): Promise<void> => {
    if (foregroundQueueDrainRunningRef.current) {
      return;
    }

    const recordingSessionId = recordingSessionIdRef.current;

    const userId = recordingUserIdRef.current;

    if (!recordingSessionId || !userId) {
      return;
    }

    foregroundQueueDrainRunningRef.current = true;

    try {
      const { drainLocationQueueRepeatedly } =
        await import("../services/locationQueueUploadService");

      const result = await drainLocationQueueRepeatedly({
        userId,
        recordingSessionId,
        intervalMs,
        distanceMeters,
        fallbackSharedOwners: normalizedLiveShareOwnerValues,
        maxIterations: 20,
      });

      console.log("Foreground SQLite queue drain completed:", {
        recordingSessionId,
        ...result,
      });

      const { cleanupProcessedLocationQueue, getLocationQueueStatusSummary } =
        await import("../services/locationLocationQueueService");

      const summary = await getLocationQueueStatusSummary({
        userId,
        recordingSessionId,
      });

      console.log("Foreground SQLite queue summary:", {
        recordingSessionId,
        ...summary,
      });

      const cleanupResult = await cleanupProcessedLocationQueue({
        retentionDays: 7,
      });

      if (cleanupResult.deletedCount > 0) {
        console.log(
          "Foreground SQLite queue cleanup completed:",
          cleanupResult,
        );
      }
    } catch (error) {
      /*
       * foreground復帰時のキュー送信に失敗しても、
       * 自動記録自体は止めない。
       */
      console.error("Foreground SQLite queue drain error:", error);
    } finally {
      foregroundQueueDrainRunningRef.current = false;
    }
  }, [intervalMs, distanceMeters, normalizedLiveShareOwnerValues]);

  const checkBackgroundTaskHealth = useCallback(
    async (heartbeatMustBeAfter?: number | null): Promise<boolean> => {
      const recordingSessionId = recordingSessionIdRef.current;

      if (!recordingSessionIdRef.current) {
        setBackgroundTaskStatus("idle");
        return true;
      }

      setBackgroundTaskStatus("checking");

      try {
        const health = await getBackgroundLocationTaskHealth(intervalMs);

        const hasExpectedHeartbeat =
          typeof heartbeatMustBeAfter === "number"
            ? await hasBackgroundTaskHeartbeatAfter(heartbeatMustBeAfter)
            : health.hasRecentHeartbeat;

        if (health.isRegistrationHealthy && hasExpectedHeartbeat) {
          setBackgroundTaskStatus("running");
          setBackgroundTaskErrorMessage(null);
          return true;
        }

        /*
         * 登録自体が壊れている、またはbackground移行後に
         * heartbeatが一度も更新されていない場合は1回だけ修復する。
         */
        if (!backgroundRepairAttemptedRef.current) {
          backgroundRepairAttemptedRef.current = true;
          setBackgroundTaskStatus("repairing");

          await repairBackgroundLocationTaskForCurrentRecording();

          /*
           * 再登録直後はheartbeat到着前なので、
           * 登録状態だけ確認する。
           */
          const repairedHealth =
            await getBackgroundLocationTaskHealth(intervalMs);

          if (repairedHealth.isRegistrationHealthy) {
            setBackgroundTaskStatus("registered");
            setBackgroundTaskErrorMessage(null);
            return true;
          }
        }

        const message =
          "バックグラウンド位置記録の動作を確認できませんでした。位置情報権限とバッテリー設定を確認してください。";

        setBackgroundTaskStatus("error");
        setBackgroundTaskErrorMessage(message);

        console.error("Background location task health check failed:", {
          recordingSessionId,
          health,
          heartbeatMustBeAfter,
        });

        return false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        setBackgroundTaskStatus("error");
        setBackgroundTaskErrorMessage(message);

        console.error("Check background task health error:", error);

        return false;
      }
    },
    [intervalMs],
  );

  const drainSQLiteQueueBeforeStop = useCallback(
    async (input: {
      userId: string;
      recordingSessionId: string;
    }): Promise<void> => {
      try {
        const { drainLocationQueueRepeatedly } =
          await import("../services/locationQueueUploadService");

        /*
         * 最終地点のSQLite投入直後でも処理できるよう、
         * 停止処理では通常より多く繰り返す。
         *
         * ただし現在のキュー取得には60秒条件があるため、
         * 後述のforceIncludeRecentが必要。
         */
        const result = await drainLocationQueueRepeatedly({
          userId: input.userId,
          recordingSessionId: input.recordingSessionId,
          intervalMs,
          distanceMeters,
          fallbackSharedOwners: normalizedLiveShareOwnerValues,
          maxIterations: 30,
          forceIncludeRecent: true,
        });

        console.log("Stop SQLite queue drain completed:", {
          recordingSessionId: input.recordingSessionId,
          ...result,
        });

        const { cleanupProcessedLocationQueue, getLocationQueueStatusSummary } =
          await import("../services/locationLocationQueueService");

        const summary = await getLocationQueueStatusSummary({
          userId: input.userId,
          recordingSessionId: input.recordingSessionId,
        });

        console.log("Stop SQLite queue summary:", {
          recordingSessionId: input.recordingSessionId,
          ...summary,
        });

        await cleanupProcessedLocationQueue({
          retentionDays: 7,
        });
      } catch (error) {
        /*
         * キュー送信に失敗しても、
         * ユーザーの停止操作自体は完了させる。
         * pendingはSQLiteに残り、次回再送可能。
         */
        console.error("Stop SQLite queue drain error:", error);
      }
    },
    [intervalMs, distanceMeters, normalizedLiveShareOwnerValues],
  );

  // 記録停止関数
  const stopRecording = useCallback(
    async (options: StopRecordingOptions = {}): Promise<string | null> => {
      /*
       * 後続処理でrefをnullにしても使用できるよう、
       * 停止対象のセッション情報を最初に退避する。
       */
      const finishedSessionId = recordingSessionIdRef.current;

      const finishedUserId = recordingUserIdRef.current;

      /*
       * foregroundの位置監視を先に止める。
       * これ以降、新しいforeground callbackを発生させない。
       */
      recordingSubscriptionRef.current?.remove();
      recordingSubscriptionRef.current = null;

      /*
       * background側の記録状態を解除する前に、
       * 最終地点を保存する。
       */
      if (!options.skipFinalLocationSave && finishedSessionId) {
        try {
          const currentLocation = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });

          await updateLiveLocation(currentLocation);

          await saveLocationLog(currentLocation, true);
        } catch (error) {
          /*
           * 最終地点の取得・保存に失敗しても、
           * 停止処理とSQLiteキュー送信は継続する。
           */
          console.error("Save stop location error:", error);
        }
      }

      /*
       * セッション情報を解除する前に、
       * SQLiteのpendingキューを送信する。
       *
       * 停止時はforceIncludeRecent=trueで、
       * 60秒未満の最新地点も送信対象にする。
       */
      if (finishedSessionId && finishedUserId) {
        try {
          await drainSQLiteQueueBeforeStop({
            userId: finishedUserId,
            recordingSessionId: finishedSessionId,
          });
        } catch (error) {
          /*
           * SQLite送信に失敗しても停止操作は完了させる。
           * 未送信行はpendingのままSQLiteへ残る。
           */
          console.error("Drain SQLite queue before stop error:", error);
        }
      }

      /*
       * 最終地点保存とSQLiteキュー送信が終わった後に、
       * background側の記録状態を解除する。
       */
      const shouldContinueLiveSharing =
        normalizedLiveShareOwnerValues.length > 0;

      try {
        await stopBackgroundLocationRecording({
          continueLiveSharing: shouldContinueLiveSharing,
        });
      } catch (error) {
        console.error("Stop background location recording error:", error);
      }

      /*
       * LiveLocationを記録停止状態へ更新する。
       */
      if (liveLocationIdRef.current) {
        try {
          const shouldContinueLiveSharing =
            normalizedLiveShareOwnerValues.length > 0;

          const result = await client.models.LiveLocation.update({
            id: liveLocationIdRef.current,
            isActive: shouldContinueLiveSharing,
            isRecording: false,
            recordingSessionId: null,
            updatedAt: new Date().toISOString(),
            sharedOwners: normalizedLiveShareOwnerValues,
          });

          if (result.errors) {
            console.error("LiveLocation stop update errors:", result.errors);
          }
        } catch (error) {
          console.error("LiveLocation stop update error:", error);
        }
      }

      /*
       * すべての停止処理が終わった後にrefを解除する。
       */
      if (normalizedLiveShareOwnerValues.length === 0) {
        liveLocationIdRef.current = null;
      }
      recordingSessionIdRef.current = null;
      recordingUserIdRef.current = null;
      isRecordingRef.current = false;

      setActiveRecordingSessionId(null);
      setRecordingStartedAt(null);
      setIsRecording(false);

      backgroundEnteredAtRef.current = null;
      backgroundRepairAttemptedRef.current = false;

      setBackgroundTaskStatus("idle");
      setBackgroundTaskErrorMessage(null);

      startLocationRef.current = null;
      lastSavedLocationRef.current = null;
      setDistanceFromStartMeters(null);

      return finishedSessionId;
    },
    [
      saveLocationLog,
      updateLiveLocation,
      drainSQLiteQueueBeforeStop,
      normalizedLiveShareOwnerValues,
    ],
  );

  // ここに追加
  const checkRecordingContinuation = useCallback(async (): Promise<void> => {
    const recordingSessionId = recordingSessionIdRef.current;

    if (!recordingSessionId) {
      return;
    }

    try {
      const evaluation =
        await evaluateRecordingContinuation(recordingSessionId);

      /*
       * 期限切れを先に判定する。
       * shouldShowConfirmationもtrueになる可能性があるため、
       * ダイアログ表示より前に処理する。
       */
      if (evaluation.isDeadlineExpired) {
        const stoppedAt = new Date().toISOString();

        await markRecordingContinuationAutoStopped(
          recordingSessionId,
          stoppedAt,
        );

        const finishedSessionId = await stopRecording();

        setContinuationPrompt(null);

        if (finishedSessionId) {
          setAutoStoppedSessionId(finishedSessionId);
        }

        return;
      }

      if (
        evaluation.shouldShowConfirmation &&
        evaluation.state?.confirmationRequired
      ) {
        setContinuationPrompt(evaluation.state);
        return;
      }

      setContinuationPrompt(null);
    } catch (error) {
      /*
       * 継続確認処理でエラーが発生しても、
       * 位置情報の記録は停止しない。
       */
      console.error("Check recording continuation error:", error);
    }
  }, [stopRecording]);

  const confirmContinuation = useCallback(async (): Promise<void> => {
    const recordingSessionId = recordingSessionIdRef.current;

    if (!recordingSessionId) {
      setContinuationPrompt(null);
      return;
    }

    try {
      await confirmRecordingContinuation(recordingSessionId);
      setContinuationPrompt(null);
    } catch (error) {
      console.error("Confirm recording continuation error:", error);
    }
  }, []);

  const clearAutoStoppedSession = useCallback(async (): Promise<void> => {
    /*
     * 自動停止通知の表示状態だけをクリアする。
     */
    setAutoStoppedSessionId(null);
  }, []);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    let cancelled = false;

    const startLiveSharingWatcher = async () => {
      if (normalizedLiveShareOwnerValues.length === 0) {
        liveSharingSubscriptionRef.current?.remove();
        liveSharingSubscriptionRef.current = null;
        return;
      }

      if (liveSharingSubscriptionRef.current) {
        return;
      }

      try {
        const subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: intervalMs,
            distanceInterval: distanceMeters,
          },
          async (location) => {
            if (appStateRef.current !== "active") {
              return;
            }

            await updateLiveLocation(location);
          },
        );

        if (cancelled) {
          subscription.remove();
          return;
        }

        liveSharingSubscriptionRef.current = subscription;

        const currentLocation = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        await updateLiveLocation(currentLocation);
      } catch (error) {
        console.error("Start foreground live sharing watcher error:", error);
      }
    };

    void startLiveSharingWatcher();

    return () => {
      cancelled = true;

      liveSharingSubscriptionRef.current?.remove();
      liveSharingSubscriptionRef.current = null;
    };
  }, [
    normalizedLiveShareOwnerValues,
    intervalMs,
    distanceMeters,
    updateLiveLocation,
  ]);

  useEffect(() => {
    return () => {
      recordingSubscriptionRef.current?.remove();
      recordingSubscriptionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;

      appStateRef.current = nextState;

      const movedToBackground =
        previousState === "active" && nextState !== "active";

      if (movedToBackground) {
        backgroundEnteredAtRef.current = Date.now();

        /*
         * backgroundへ移った後のheartbeatを判定するため、
         * 修復試行状態をリセットする。
         */
        backgroundRepairAttemptedRef.current = false;
        return;
      }

      const returnedToForeground =
        previousState !== "active" && nextState === "active";

      if (!returnedToForeground) {
        return;
      }

      if (!recordingSessionIdRef.current) {
        return;
      }

      void drainSQLiteQueueOnForeground();

      const backgroundEnteredAt = backgroundEnteredAtRef.current;

      /*
       * backgroundへ移行した時刻を取得できない場合は、
       * heartbeatによる自動修復を行わない。
       */
      if (typeof backgroundEnteredAt !== "number") {
        void getBackgroundLocationTaskHealth(intervalMs).then((health) => {
          setBackgroundTaskStatus(
            health.isRegistrationHealthy
              ? health.hasRecentHeartbeat
                ? "running"
                : "registered"
              : "error",
          );

          if (!health.isRegistrationHealthy) {
            setBackgroundTaskErrorMessage(
              "バックグラウンド位置タスクの登録状態に異常があります。",
            );
          }
        });

        return;
      }

      const backgroundDurationMs = Date.now() - backgroundEnteredAt;

      /*
       * 短時間のbackground移行では位置イベントが来ないことがある。
       *
       * 設定間隔の2倍＋5秒、または30秒の長い方を超えた場合だけ、
       * background移行後のheartbeatを厳密に確認する。
       */
      const minimumHeartbeatCheckDurationMs = Math.max(
        intervalMs * 2 + 5_000,
        30_000,
      );

      if (backgroundDurationMs < minimumHeartbeatCheckDurationMs) {
        /*
         * 短時間のbackground移行では、
         * 正常なタスクを誤って再起動しない。
         *
         * 登録状態だけを確認する。
         */
        void getBackgroundLocationTaskHealth(intervalMs).then((health) => {
          if (health.isRegistrationHealthy) {
            setBackgroundTaskStatus(
              health.hasRecentHeartbeat ? "running" : "registered",
            );
            setBackgroundTaskErrorMessage(null);
            return;
          }

          /*
           * 登録状態そのものが壊れている場合だけ修復する。
           */
          void checkBackgroundTaskHealth(null);
        });

        return;
      }

      /*
       * 十分な時間backgroundにいた場合だけ、
       * background移行後のheartbeat発生を確認する。
       */
      void checkBackgroundTaskHealth(backgroundEnteredAt).then((healthy) => {
        if (healthy) {
          return;
        }

        Alert.alert(
          "バックグラウンド記録を確認できません",
          [
            "バックグラウンド位置記録が正常に動作していない可能性があります。",
            "",
            "位置情報を「常に許可」に設定し、バッテリー使用量を「制限なし」にしてください。",
          ].join("\n"),
        );
      });
    });

    return () => {
      subscription.remove();
    };
  }, [drainSQLiteQueueOnForeground, checkBackgroundTaskHealth, intervalMs]);

  // ここに追加
  useEffect(() => {
    if (!isRecording) {
      return;
    }

    /*
     * 記録開始・復元直後にも一度確認する。
     */
    void checkRecordingContinuation();

    /*
     * アプリがforegroundで動作している間だけ、
     * 30秒ごとに継続確認条件と期限切れを確認する。
     */
    const timerId = setInterval(() => {
      void checkRecordingContinuation();
    }, 30_000);

    return () => {
      clearInterval(timerId);
    };
  }, [isRecording, checkRecordingContinuation]);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    /*
     * startLocationUpdatesAsync直後は、
     * タスク登録完了と最初のイベント到着に時間差がある。
     */
    const verificationDelayMs = Math.max(intervalMs * 2 + 5_000, 30_000);

    const timerId = setTimeout(() => {
      /*
       * アプリがまだforegroundの場合は、
       * heartbeatが来ていなくても即異常とはしない。
       *
       * 登録状態だけを確認し、background移行後は
       * AppState監視で実動確認する。
       */
      void getBackgroundLocationTaskHealth(intervalMs).then((health) => {
        if (health.isRegistrationHealthy) {
          setBackgroundTaskStatus(
            health.hasRecentHeartbeat ? "running" : "registered",
          );

          return;
        }

        void checkBackgroundTaskHealth(null);
      });
    }, verificationDelayMs);

    return () => {
      clearTimeout(timerId);
    };
  }, [isRecording, intervalMs, checkBackgroundTaskHealth]);

  useEffect(() => {
    void restoreRecordingState();
  }, [restoreRecordingState]);

  return {
    isRecording,
    recordingStartedAt,
    activeRecordingSessionId,
    distanceFromStartMeters,

    backgroundTaskStatus,
    backgroundTaskErrorMessage,

    continuationPrompt,
    autoStoppedSessionId,

    startRecording,
    stopRecording,

    confirmContinuation,
    clearAutoStoppedSession,
  };
}

function createLocationDuplicateKey(
  latitude: number,
  longitude: number,
  recordedAtMs: number,
) {
  return [recordedAtMs, latitude.toFixed(7), longitude.toFixed(7)].join(":");
}

function createRecordingSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type BatterySnapshot = {
  batteryLevel: number | null;
  batteryState: string | null;
  lowPowerMode: boolean | null;
};

async function getBatterySnapshot(): Promise<BatterySnapshot> {
  try {
    const [batteryLevel, batteryState, lowPowerMode] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
      Battery.isLowPowerModeEnabledAsync(),
    ]);

    return {
      batteryLevel:
        typeof batteryLevel === "number" && batteryLevel >= 0
          ? batteryLevel
          : null,
      batteryState: formatBatteryState(batteryState),
      lowPowerMode,
    };
  } catch (error) {
    console.error("Battery snapshot error:", error);

    return {
      batteryLevel: null,
      batteryState: "unknown",
      lowPowerMode: null,
    };
  }
}

function formatBatteryState(state: Battery.BatteryState) {
  switch (state) {
    case Battery.BatteryState.UNPLUGGED:
      return "unplugged";
    case Battery.BatteryState.CHARGING:
      return "charging";
    case Battery.BatteryState.FULL:
      return "full";
    case Battery.BatteryState.UNKNOWN:
    default:
      return "unknown";
  }
}
