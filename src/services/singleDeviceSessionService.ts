import AsyncStorage from "@react-native-async-storage/async-storage";
import { getCurrentUser } from "aws-amplify/auth";
import { v4 as uuidv4 } from "uuid";

import { client } from "../lib/client";

const DEVICE_ID_STORAGE_KEY = "location-tracker-single-device-id";

const REGISTERED_USER_ID_STORAGE_KEY =
    "location-tracker-single-device-registered-user-id";

type DeviceSessionResult = {
    success: boolean;
    isActive: boolean;
    message: string;
};

type DeviceSessionQueryResult = {
    data?: DeviceSessionResult | null;
    errors?: readonly unknown[];
};

export async function getOrCreateDeviceId(): Promise<string> {
    const existing = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);

    if (existing) {
        return existing;
    }

    const deviceId = uuidv4();

    await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);

    return deviceId;
}

export async function getRegisteredUserId(): Promise<string | null> {
    return await AsyncStorage.getItem(REGISTERED_USER_ID_STORAGE_KEY);
}

export async function clearLocalDeviceSessionRegistration(): Promise<void> {
    /*
     * deviceId自体は削除しない。
     *
     * 同じ物理端末であることを維持する。
     */
    await AsyncStorage.removeItem(REGISTERED_USER_ID_STORAGE_KEY);
}

/*
 * 現在の端末を有効端末として登録する。
 */
export async function activateCurrentDeviceSession(): Promise<void> {
    const user = await getCurrentUser();

    const deviceId = await getOrCreateDeviceId();

    const result = (await (client.mutations.activateMyDeviceSession as any)({
        deviceId,
    })) as DeviceSessionQueryResult;

    if (result.errors?.length) {
        console.error("[SingleDeviceSession] activate errors:", result.errors);

        throw new Error("端末セッションを登録できませんでした。");
    }

    if (!result.data?.success) {
        throw new Error(
            result.data?.message ?? "端末セッションを登録できませんでした。",
        );
    }

    await AsyncStorage.setItem(REGISTERED_USER_ID_STORAGE_KEY, user.userId);

    console.log("[SingleDeviceSession] Device activated:", {
        userId: user.userId,
        deviceId,
    });
}

/*
 * 現在の端末が有効端末か確認する。
 */
export async function checkCurrentDeviceSession(): Promise<boolean> {
    const deviceId = await getOrCreateDeviceId();

    const result = (await (client.queries.checkMyDeviceSession as any)({
        deviceId,
    })) as DeviceSessionQueryResult;

    if (result.errors?.length) {
        console.error("[SingleDeviceSession] check errors:", result.errors);

        throw new Error("端末セッションを確認できませんでした。");
    }

    return result.data?.isActive === true;
}

/*
 * アプリ起動時の処理。
 *
 * このアカウントをこの端末で初めて使う場合:
 * → activeDeviceとして登録
 *
 * すでにこの端末で登録済み:
 * → activeDeviceか確認だけ行う
 */
export async function initializeCurrentDeviceSession(): Promise<boolean> {
    const user = await getCurrentUser();

    const registeredUserId = await getRegisteredUserId();

    if (registeredUserId !== user.userId) {
        await activateCurrentDeviceSession();

        return true;
    }

    return await checkCurrentDeviceSession();
}

/*
 * 通常ログアウト用。
 *
 * 現在有効な端末だった場合だけ
 * サーバー側セッションを削除する。
 */
export async function releaseCurrentDeviceSession(): Promise<void> {
    const deviceId = await getOrCreateDeviceId();

    try {
        const result = (await (client.mutations.releaseMyDeviceSession as any)({
            deviceId,
        })) as DeviceSessionQueryResult;

        if (result.errors?.length) {
            console.error(
                "[SingleDeviceSession] release errors:",
                result.errors,
            );
        }
    } finally {
        await clearLocalDeviceSessionRegistration();
    }
}
