// src/services/backgroundLocationService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Alert, Linking, Platform } from "react-native";
import { client } from "../lib/client";

import {
    BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY,
    BACKGROUND_LOCATION_TASK_NAME,
    BACKGROUND_RECORDING_STATE_KEY,
    type BackgroundLocationTaskHeartbeat,
} from "../tasks/backgroundLocationTask";
import { saveBackgroundLocationDebugLog } from "./backgroundLocationDebugLogService";

export const BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED =
    "BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED";

export const BACKGROUND_LOCATION_DISCLOSURE_DECLINED =
    "BACKGROUND_LOCATION_DISCLOSURE_DECLINED";

export const FOREGROUND_LAST_SAVED_LOCATION_KEY =
    "location-tracker-foreground-last-saved-location";

export class BackgroundLocationPermissionError extends Error {
    code = BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED;

    constructor() {
        super(BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED);
        this.name = "BackgroundLocationPermissionError";
    }
}

export const FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED =
    "FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED";

export function isForegroundLocationPermissionError(error: unknown) {
    return (
        error instanceof Error &&
        error.message === FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED
    );
}

export function isBackgroundLocationDisclosureDeclined(error: unknown) {
    return (
        error instanceof Error &&
        error.message === BACKGROUND_LOCATION_DISCLOSURE_DECLINED
    );
}

export function isBackgroundLocationPermissionError(error: unknown) {
    return (
        error instanceof BackgroundLocationPermissionError ||
        (error instanceof Error &&
            error.message === BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED)
    );
}

type StartBackgroundLocationRecordingParams = {
    userId: string;
    recordingSessionId: string;
    startedAt?: string | null;
    recordingExpiresAt?: string | null;
    intervalMs: number;
    distanceMeters: number;
    liveShareOwnerValues?: string[];
    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;
    liveLocationId?: string | null;
};
export type BackgroundRecordingState = {
    userId: string;
    isRecording: boolean;
    recordingSessionId?: string | null;
    startedAt?: string | null;
    recordingExpiresAt?: string | null;
    liveShareOwnerValues?: string[];
    liveLocationId?: string | null;
    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;
    intervalMs: number;
    distanceMeters: number;
};

type StopBackgroundLocationRecordingOptions = {
    continueLiveSharing?: boolean;
};

export type BackgroundLocationTaskHealth = {
    isDefined: boolean;
    isRegistered: boolean;
    hasStartedLocationUpdates: boolean;

    heartbeat: BackgroundLocationTaskHeartbeat | null;
    heartbeatAgeMs: number | null;
    heartbeatStaleMs: number;
    hasRecentHeartbeat: boolean;

    isRegistrationHealthy: boolean;
};

async function safeHasStartedLocationUpdates(): Promise<boolean> {
    try {
        return await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );
    } catch (error) {
        console.error("Check background location updates status error:", error);

        return false;
    }
}

const BACKGROUND_TASK_RESTART_WAIT_MS = 1_500;

/*
 * heartbeatの許容時間は、設定間隔の3倍または2分の長い方とする。
 *
 * 5分設定などでも短すぎる時間で異常判定しない。
 */
function getBackgroundTaskHeartbeatStaleMs(intervalMs: number): number {
    return Math.max(intervalMs * 3, 120_000);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function readBackgroundLocationTaskHeartbeat(): Promise<BackgroundLocationTaskHeartbeat | null> {
    try {
        const raw = await AsyncStorage.getItem(
            BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY,
        );

        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(
            raw,
        ) as Partial<BackgroundLocationTaskHeartbeat>;

        if (
            typeof parsed.firedAt !== "number" ||
            !Number.isFinite(parsed.firedAt)
        ) {
            return null;
        }

        return {
            firedAt: parsed.firedAt,
            taskFiredAt:
                typeof parsed.taskFiredAt === "string"
                    ? parsed.taskFiredAt
                    : new Date(parsed.firedAt).toISOString(),
            locationsLength:
                typeof parsed.locationsLength === "number"
                    ? parsed.locationsLength
                    : 0,
            recordingSessionId:
                typeof parsed.recordingSessionId === "string"
                    ? parsed.recordingSessionId
                    : null,
            isRecording: parsed.isRecording === true,
            userId: typeof parsed.userId === "string" ? parsed.userId : null,
        };
    } catch (error) {
        console.error("Read background location task heartbeat error:", error);

        return null;
    }
}

export async function startBackgroundLocationRecording({
    userId,
    recordingSessionId,
    startedAt = null,
    recordingExpiresAt = null,
    intervalMs,
    distanceMeters,
    liveShareOwnerValues = [],
    liveLocationId = null,
    lastSavedLocation = null,
}: StartBackgroundLocationRecordingParams) {
    const normalizedLiveShareOwnerValues = Array.from(
        new Set(liveShareOwnerValues.filter(Boolean)),
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "startBackgroundLocationRecordingCalled",
        details: {
            startedAt,
            recordingExpiresAt,
            intervalMs,
            distanceMeters,
            liveShareOwnerValues: normalizedLiveShareOwnerValues,
            liveLocationId,
            hasLastSavedLocation: Boolean(lastSavedLocation),
        },
    });

    await ensureBackgroundLocationPermission(userId, recordingSessionId);

    /*
     * 新しい自動記録状態で上書きする前に、
     * 現在地共有のみの状態を退避する。
     *
     * 起動失敗時には、この状態へ戻す。
     */
    const previousRaw = await AsyncStorage.getItem(
        BACKGROUND_RECORDING_STATE_KEY,
    );

    let previousState: BackgroundRecordingState | null = null;

    if (previousRaw) {
        try {
            previousState = JSON.parse(previousRaw) as BackgroundRecordingState;
        } catch (error) {
            console.error(
                "Parse previous background recording state error:",
                error,
            );

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "previousBackgroundRecordingStateParseFailed",
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });
        }
    }

    const nextState: BackgroundRecordingState = {
        userId,
        isRecording: true,
        recordingSessionId,
        startedAt,
        recordingExpiresAt,
        intervalMs,
        distanceMeters,
        liveShareOwnerValues: normalizedLiveShareOwnerValues,
        liveLocationId,
        lastSavedLocation,
    };

    /*
     * 既に正常な共有用タスクが動作している場合、
     * 次回タスク発火時から自動記録へ切り替えられるよう、
     * 先にstateをisRecording=trueへ更新する。
     */
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );

    const healthBeforeStart = await getBackgroundLocationTaskHealth(intervalMs);

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundLocationTaskHealthCheckedBeforeRecording",
        hasStartedLocationUpdates: healthBeforeStart.hasStartedLocationUpdates,
        details: {
            isDefined: healthBeforeStart.isDefined,
            isRegistered: healthBeforeStart.isRegistered,
            hasRecentHeartbeat: healthBeforeStart.hasRecentHeartbeat,
            heartbeatAgeMs: healthBeforeStart.heartbeatAgeMs,
            heartbeatStaleMs: healthBeforeStart.heartbeatStaleMs,
            previousStateExists: Boolean(previousState),
            previousIsRecording: previousState?.isRecording ?? null,
            previousRecordingSessionId:
                previousState?.recordingSessionId ?? null,
        },
    });

    try {
        /*
         * タスク定義、TaskManager登録、Location登録が正常なら、
         * 既存タスクを停止せずに再利用する。
         */
        if (healthBeforeStart.isRegistrationHealthy) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskReusedForRecording",
                hasStartedLocationUpdates: true,
                details: {
                    hasRecentHeartbeat: healthBeforeStart.hasRecentHeartbeat,
                    heartbeatAgeMs: healthBeforeStart.heartbeatAgeMs,
                    previousIsRecording: previousState?.isRecording ?? null,
                },
            });

            return;
        }

        /*
         * 未登録または登録状態に不整合がある場合だけ、
         * 安全な停止・再登録を行う。
         */
        await restartBackgroundLocationUpdates({
            userId,
            recordingSessionId,
            intervalMs,
            distanceMeters,
            isRecording: true,
            reason: "registrationNotHealthyAtRecordingStart",
        });

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startBackgroundLocationRecordingCompleted",
            hasStartedLocationUpdates: true,
            details: {
                reusedExistingTask: false,
                intervalMs,
                distanceMeters,
            },
        });
    } catch (error) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startLocationUpdatesFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                error instanceof Error ? error.message : String(error),
            details: {
                restoringPreviousState: Boolean(previousState),
            },
        });

        /*
         * 開始失敗時は、記録開始前のstateへ戻す。
         */
        if (previousState) {
            await AsyncStorage.setItem(
                BACKGROUND_RECORDING_STATE_KEY,
                JSON.stringify(previousState),
            );
        } else {
            await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);
        }

        throw error;
    }
}

export async function stopBackgroundLocationRecording(
    options: StopBackgroundLocationRecordingOptions = {},
) {
    const continueLiveSharing = options.continueLiveSharing === true;
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    let recordingSessionId: string | null = null;
    let userId: string | null = null;
    let liveLocationId: string | null = null;
    let currentState: BackgroundRecordingState | null = null;

    if (raw) {
        try {
            const state = JSON.parse(raw) as BackgroundRecordingState;
            currentState = state;
            recordingSessionId = state.recordingSessionId ?? null;
            userId = state.userId ?? null;
            liveLocationId = state.liveLocationId ?? null;
        } catch (error) {
            console.error(
                "Parse background recording state on stop error:",
                error,
            );
        }
    }

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "stopBackgroundLocationRecordingCalled",
        details: {
            continueLiveSharing,
        },
    });

    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    if (continueLiveSharing && currentState) {
        const nextState: BackgroundRecordingState = {
            ...currentState,
            isRecording: false,
            recordingSessionId: null,
            startedAt: null,
            recordingExpiresAt: null,
            lastSavedLocation: null,
        };

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify(nextState),
        );

        if (liveLocationId) {
            try {
                const result = await client.models.LiveLocation.update({
                    id: liveLocationId,
                    isActive: true,
                    isRecording: false,
                    recordingSessionId: null,
                    updatedAt: new Date().toISOString(),
                    sharedOwners: nextState.liveShareOwnerValues ?? [],
                });

                if (result.errors) {
                    console.error(
                        "Background LiveLocation continue sharing update errors:",
                        result.errors,
                    );
                }
            } catch (error) {
                console.error(
                    "Background LiveLocation continue sharing update error:",
                    error,
                );

                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName:
                        "backgroundLiveLocationContinueSharingUpdateFailed",
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                });
            }
        }

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLiveSharingContinuedAfterRecordingStop",
            hasStartedLocationUpdates: hasStarted,
            details: {
                liveLocationId,
                sharedOwnerCount: nextState.liveShareOwnerValues?.length ?? 0,
            },
        });

        return;
    }

    /*
     * 共有を継続しない場合だけ、
     * バックグラウンド位置更新を完全停止する。
     */
    if (hasStarted) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK_NAME);
    }

    const hasStartedAfterStop = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "stopBackgroundLocationRecordingCompleted",
        hasStartedLocationUpdates: hasStartedAfterStop,
        details: {
            hasStartedBeforeStop: hasStarted,
            continueLiveSharing: false,
        },
    });

    if (liveLocationId) {
        try {
            await client.models.LiveLocation.update({
                id: liveLocationId,
                isActive: false,
                isRecording: false,
                recordingSessionId: null,
                updatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Background LiveLocation stop update error:", error);

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLiveLocationStopUpdateFailed",
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });
        }
    }

    await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundRecordingStateRemoved",
    });
}

function showBackgroundLocationDisclosure(): Promise<boolean> {
    return new Promise((resolve) => {
        let resolved = false;

        const finish = (accepted: boolean) => {
            if (resolved) {
                return;
            }

            resolved = true;
            resolve(accepted);
        };

        Alert.alert(
            "バックグラウンド位置情報について",
            [
                "このアプリは、自動記録中の移動ルートを作成するため、アプリを閉じている間や使用していない間も、バックグラウンドで位置情報を取得して保存します。",
                "",
                "位置情報は、移動履歴の作成、ルートの地図表示、およびユーザーが明示的に開始した現在地共有に使用します。",
                "",
                "現在地共有を開始した場合は、ユーザーが選択した共有相手に位置情報が表示されます。",
            ].join("\n"),
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                    onPress: () => {
                        finish(false);
                    },
                },
                {
                    text: "次へ",
                    onPress: () => {
                        finish(true);
                    },
                },
            ],
            {
                cancelable: true,
                onDismiss: () => {
                    /*
                     * Androidの戻るボタンやダイアログ外タップは、
                     * 同意として扱わない。
                     */
                    finish(false);
                },
            },
        );
    });
}

export async function ensureBackgroundLocationPermission(
    userId?: string | null,
    recordingSessionId?: string | null,
) {
    /*
     * 最初はrequestではなくgetで、現在の権限状態だけを確認する。
     *
     * Androidでは、OS権限ダイアログより先に
     * アプリ内の事前説明を表示する必要がある。
     */
    let foregroundPermission = await Location.getForegroundPermissionsAsync();

    let backgroundPermission = await Location.getBackgroundPermissionsAsync();

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "locationPermissionsCheckedBeforeDisclosure",
        foregroundPermissionStatus: foregroundPermission.status,
        foregroundPermissionGranted: foregroundPermission.granted,
        foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
        backgroundPermissionStatus: backgroundPermission.status,
        backgroundPermissionGranted: backgroundPermission.granted,
        backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        details: {
            platform: Platform.OS,
            requiresForegroundPermission:
                foregroundPermission.status !==
                Location.PermissionStatus.GRANTED,
            requiresBackgroundPermission:
                backgroundPermission.status !==
                Location.PermissionStatus.GRANTED,
        },
    });

    const requiresForegroundPermission =
        foregroundPermission.status !== Location.PermissionStatus.GRANTED;

    const requiresBackgroundPermission =
        backgroundPermission.status !== Location.PermissionStatus.GRANTED;

    /*
     * Androidでこれから位置権限を要求する場合は、
     * OS権限ダイアログより先に事前説明を表示する。
     *
     * 既に両方許可済みの場合は表示しない。
     */
    if (
        Platform.OS === "android" &&
        (requiresForegroundPermission || requiresBackgroundPermission)
    ) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationDisclosureShown",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
            backgroundPermissionStatus: backgroundPermission.status,
            backgroundPermissionGranted: backgroundPermission.granted,
            backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        });

        const accepted = await showBackgroundLocationDisclosure();

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: accepted
                ? "backgroundLocationDisclosureAccepted"
                : "backgroundLocationDisclosureDeclined",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
            backgroundPermissionStatus: backgroundPermission.status,
            backgroundPermissionGranted: backgroundPermission.granted,
            backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        });

        if (!accepted) {
            throw new Error(BACKGROUND_LOCATION_DISCLOSURE_DECLINED);
        }
    }

    /*
     * 前景権限が未許可の場合だけ要求する。
     */
    if (foregroundPermission.status !== Location.PermissionStatus.GRANTED) {
        foregroundPermission =
            await Location.requestForegroundPermissionsAsync();

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "foregroundPermissionRequested",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
        });
    } else {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "foregroundPermissionAlreadyGranted",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
        });
    }

    if (foregroundPermission.status !== Location.PermissionStatus.GRANTED) {
        if (foregroundPermission.canAskAgain) {
            Alert.alert(
                "位置情報の許可が必要です",
                [
                    "自動記録を使うには、位置情報の使用を許可してください。",
                    "",
                    "もう一度「自動記録開始」を押し、OSの権限画面で「アプリの使用中のみ」を選択してください。",
                ].join("\n"),
                [{ text: "OK" }],
            );
        } else {
            Alert.alert(
                "位置情報の設定が必要です",
                [
                    "位置情報の権限が無効になっています。",
                    "",
                    "端末の設定で、このアプリの位置情報を「アプリの使用中のみ許可」または「常に許可」に変更してください。",
                    "",
                    "変更後はアプリへ戻り、もう一度「自動記録開始」を押してください。",
                ].join("\n"),
                [
                    {
                        text: "キャンセル",
                        style: "cancel",
                    },
                    {
                        text: "設定を開く",
                        onPress: () => {
                            void Linking.openSettings();
                        },
                    },
                ],
            );
        }

        throw new Error(FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED);
    }

    /*
     * 前景権限取得後に、背景権限を再確認する。
     *
     * Androidでは前景権限取得によって状態が変化する可能性がある。
     */
    backgroundPermission = await Location.getBackgroundPermissionsAsync();

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundPermissionChecked",
        backgroundPermissionStatus: backgroundPermission.status,
        backgroundPermissionGranted: backgroundPermission.granted,
        backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
    });

    if (backgroundPermission.status === Location.PermissionStatus.GRANTED) {
        return;
    }

    /*
     * OSが再質問を許可している場合だけ権限要求を実行する。
     *
     * canAskAgain=falseの場合、requestを繰り返しても
     * ダイアログが表示されないため設定画面へ案内する。
     */
    if (backgroundPermission.canAskAgain) {
        backgroundPermission =
            await Location.requestBackgroundPermissionsAsync();

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundPermissionRequested",
            backgroundPermissionStatus: backgroundPermission.status,
            backgroundPermissionGranted: backgroundPermission.granted,
            backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        });
    }

    if (backgroundPermission.status === Location.PermissionStatus.GRANTED) {
        return;
    }

    Alert.alert(
        "位置情報の「常に許可」が必要です",
        [
            "バックグラウンドで自動記録を続けるには、端末の設定で位置情報を「常に許可」に変更してください。",
            "",
            "変更後はアプリに戻り、もう一度「自動記録開始」を押してください。",
        ].join("\n"),
        [
            {
                text: "キャンセル",
                style: "cancel",
            },
            {
                text: "設定を開く",
                onPress: () => {
                    void Linking.openSettings();
                },
            },
        ],
    );

    throw new BackgroundLocationPermissionError();
}

export async function updateBackgroundRecordingLiveLocationId(
    liveLocationId: string | null,
) {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return;
    }

    try {
        const state = JSON.parse(raw);

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify({
                ...state,
                liveLocationId,
            }),
        );
    } catch (error) {
        console.error("Update background liveLocationId error:", error);
    }
}

export async function getBackgroundRecordingStatus(): Promise<{
    hasStarted: boolean;
    state: BackgroundRecordingState | null;
}> {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return {
            hasStarted,
            state: null,
        };
    }

    try {
        const state = JSON.parse(raw) as BackgroundRecordingState;

        return {
            hasStarted,
            state,
        };
    } catch (error) {
        console.error("Parse background recording state error:", error);

        return {
            hasStarted,
            state: null,
        };
    }
}

export async function updateBackgroundRecordingExpiresAt(
    recordingSessionId: string,
    recordingExpiresAt: string | null,
): Promise<void> {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return;
    }

    try {
        const state = JSON.parse(raw) as BackgroundRecordingState;

        if (state.recordingSessionId !== recordingSessionId) {
            return;
        }

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify({
                ...state,
                recordingExpiresAt,
            }),
        );
    } catch (error) {
        console.error("Update background recordingExpiresAt error:", error);
    }
}

export async function updateForegroundLastSavedLocation(lastSavedLocation: {
    latitude: number;
    longitude: number;
    recordedAt: number;
}): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(
            FOREGROUND_LAST_SAVED_LOCATION_KEY,
        );

        if (raw) {
            const current = JSON.parse(raw);

            if (
                typeof current?.recordedAt === "number" &&
                current.recordedAt >= lastSavedLocation.recordedAt
            ) {
                return;
            }
        }

        await AsyncStorage.setItem(
            FOREGROUND_LAST_SAVED_LOCATION_KEY,
            JSON.stringify(lastSavedLocation),
        );
    } catch (error) {
        console.error("Update foreground lastSavedLocation error:", error);
    }
}

export async function getBackgroundLocationTaskHealth(
    intervalMs: number,
): Promise<BackgroundLocationTaskHealth> {
    const [isRegistered, hasStartedLocationUpdates, heartbeat] =
        await Promise.all([
            TaskManager.isTaskRegisteredAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            ).catch((error) => {
                console.error("Check TaskManager registration error:", error);

                return false;
            }),

            safeHasStartedLocationUpdates(),

            readBackgroundLocationTaskHeartbeat(),
        ]);

    const isDefined = TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK_NAME);

    const heartbeatStaleMs = getBackgroundTaskHeartbeatStaleMs(intervalMs);

    const heartbeatAgeMs = heartbeat
        ? Math.max(0, Date.now() - heartbeat.firedAt)
        : null;

    const hasRecentHeartbeat =
        heartbeatAgeMs !== null && heartbeatAgeMs <= heartbeatStaleMs;

    return {
        isDefined,
        isRegistered,
        hasStartedLocationUpdates,

        heartbeat,
        heartbeatAgeMs,
        heartbeatStaleMs,
        hasRecentHeartbeat,

        isRegistrationHealthy:
            isDefined && isRegistered && hasStartedLocationUpdates,
    };
}

function createBackgroundLocationTaskOptions(
    intervalMs: number,
    distanceMeters: number,
    isRecording: boolean,
): Location.LocationTaskOptions {
    return {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: intervalMs,
        distanceInterval: distanceMeters,
        deferredUpdatesInterval: intervalMs,
        deferredUpdatesDistance: distanceMeters,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
            notificationTitle: isRecording
                ? "位置情報を記録中"
                : "現在地を共有中",
            notificationBody: isRecording
                ? "自動記録をバックグラウンドで継続しています"
                : "現在地共有をバックグラウンドで継続しています",
            notificationColor: "#4b6f8f",
        },
    };
}

async function restartBackgroundLocationUpdates(input: {
    userId: string;
    recordingSessionId: string | null;
    intervalMs: number;
    distanceMeters: number;
    isRecording: boolean;
    reason: string;
}): Promise<void> {
    const {
        userId,
        recordingSessionId,
        intervalMs,
        distanceMeters,
        isRecording,
        reason,
    } = input;

    const hasStartedBeforeRestart = await safeHasStartedLocationUpdates();

    const isRegisteredBeforeRestart = await TaskManager.isTaskRegisteredAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    ).catch(() => false);

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundLocationTaskRestartStarted",
        hasStartedLocationUpdates: hasStartedBeforeRestart,
        details: {
            reason,
            isRegisteredBeforeRestart,
            isDefined: TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK_NAME),
            intervalMs,
            distanceMeters,
            isRecording,
        },
    });

    /*
     * 登録されている場合だけ停止する。
     */
    if (hasStartedBeforeRestart || isRegisteredBeforeRestart) {
        try {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        } catch (error) {
            /*
             * Location側では未開始だがTaskManager登録だけ残っている
             * ケースを考慮する。
             */
            console.error(
                "Stop background location updates before restart error:",
                error,
            );

            const stillRegistered = await TaskManager.isTaskRegisteredAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            ).catch(() => false);

            if (stillRegistered) {
                throw error;
            }
        }

        /*
         * Androidネイティブ側のサービス停止処理が完了する時間を確保する。
         */
        await sleep(BACKGROUND_TASK_RESTART_WAIT_MS);
    }

    const hasStartedAfterStop = await safeHasStartedLocationUpdates();

    const isRegisteredAfterStop = await TaskManager.isTaskRegisteredAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    ).catch(() => false);

    if (hasStartedAfterStop || isRegisteredAfterStop) {
        const error = new Error(
            "Background location task remained registered after stop.",
        );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskRestartStopFailed",
            hasStartedLocationUpdates: hasStartedAfterStop,
            errorMessage: error.message,
            details: {
                isRegisteredAfterStop,
            },
        });

        throw error;
    }

    await Location.startLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
        createBackgroundLocationTaskOptions(
            intervalMs,
            distanceMeters,
            isRecording,
        ),
    );

    const healthAfterStart = await getBackgroundLocationTaskHealth(intervalMs);

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundLocationTaskRestartCompleted",
        hasStartedLocationUpdates: healthAfterStart.hasStartedLocationUpdates,
        details: {
            reason,
            isDefined: healthAfterStart.isDefined,
            isRegistered: healthAfterStart.isRegistered,
            hasRecentHeartbeat: healthAfterStart.hasRecentHeartbeat,
            heartbeatAgeMs: healthAfterStart.heartbeatAgeMs,
        },
    });

    if (!healthAfterStart.isRegistrationHealthy) {
        throw new Error(
            "Background location task registration verification failed.",
        );
    }
}

export async function repairBackgroundLocationTaskForCurrentRecording(): Promise<BackgroundLocationTaskHealth> {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        throw new Error("Background recording state was not found.");
    }

    const state = JSON.parse(raw) as BackgroundRecordingState;

    if (
        state.isRecording !== true ||
        !state.recordingSessionId ||
        !state.userId
    ) {
        throw new Error("Active background recording state was not found.");
    }

    await restartBackgroundLocationUpdates({
        userId: state.userId,
        recordingSessionId: state.recordingSessionId,
        intervalMs: state.intervalMs,
        distanceMeters: state.distanceMeters,
        isRecording: true,
        reason: "heartbeatNotUpdatedDuringRecording",
    });

    return await getBackgroundLocationTaskHealth(state.intervalMs);
}

export async function hasBackgroundTaskHeartbeatAfter(
    timestampMs: number,
): Promise<boolean> {
    const heartbeat = await readBackgroundLocationTaskHeartbeat();

    return Boolean(heartbeat && heartbeat.firedAt > timestampMs);
}
