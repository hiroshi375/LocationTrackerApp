import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";

import { env } from "$amplify/env/device-session-api";

import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } =
    await getAmplifyDataClientConfig(env);

Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>();

function getCallerUserId(event: any): string {
    const userId = event?.identity?.sub;

    if (!userId || typeof userId !== "string") {
        throw new Error("ログインユーザーを特定できません。");
    }

    return userId;
}

/*
 * この端末を、このアカウントの有効端末として登録する。
 *
 * 新しい端末から呼ばれた場合、
 * 以前のactiveDeviceIdを上書きする。
 */
async function activateMyDeviceSession(event: any) {
    const userId = getCallerUserId(event);

    const deviceId = event.arguments.deviceId;

    if (!deviceId || typeof deviceId !== "string") {
        throw new Error("端末IDを取得できませんでした。");
    }

    const now = new Date().toISOString();

    const existingResult = await client.models.UserDeviceSession.get({
        userId,
    });

    if (existingResult.errors) {
        console.error(
            "[DeviceSession] Get session errors:",
            existingResult.errors,
        );

        throw new Error("端末セッションを確認できませんでした。");
    }

    if (existingResult.data) {
        const updateResult = await client.models.UserDeviceSession.update({
            userId,
            activeDeviceId: deviceId,
            lastLoginAt: now,
            lastCheckedAt: now,
        });

        if (updateResult.errors) {
            console.error(
                "[DeviceSession] Update session errors:",
                updateResult.errors,
            );

            throw new Error("端末セッションを更新できませんでした。");
        }
    } else {
        const createResult = await client.models.UserDeviceSession.create({
            userId,
            activeDeviceId: deviceId,
            lastLoginAt: now,
            lastCheckedAt: now,
        });

        if (createResult.errors) {
            console.error(
                "[DeviceSession] Create session errors:",
                createResult.errors,
            );

            /*
             * ほぼ同時に別端末からcreateされた場合を考慮し、
             * updateを1回試す。
             */
            const retryUpdateResult =
                await client.models.UserDeviceSession.update({
                    userId,
                    activeDeviceId: deviceId,
                    lastLoginAt: now,
                    lastCheckedAt: now,
                });

            if (retryUpdateResult.errors) {
                console.error(
                    "[DeviceSession] Retry update errors:",
                    retryUpdateResult.errors,
                );

                throw new Error("端末セッションを登録できませんでした。");
            }
        }
    }

    console.log("[DeviceSession] Device activated:", {
        userId,
        deviceId,
    });

    return {
        success: true,
        isActive: true,
        message: "この端末を有効端末として登録しました。",
    };
}

/*
 * 現在の端末が有効端末か確認する。
 */
async function checkMyDeviceSession(event: any) {
    const userId = getCallerUserId(event);

    const deviceId = event.arguments.deviceId;

    if (!deviceId || typeof deviceId !== "string") {
        throw new Error("端末IDを取得できませんでした。");
    }

    const result = await client.models.UserDeviceSession.get({
        userId,
    });

    if (result.errors) {
        console.error("[DeviceSession] Check session errors:", result.errors);

        throw new Error("端末セッションを確認できませんでした。");
    }

    const session = result.data;

    if (!session) {
        return {
            success: true,
            isActive: false,
            message: "有効な端末セッションがありません。",
        };
    }

    const isActive = session.activeDeviceId === deviceId;

    /*
     * 有効端末だけ最終確認日時を更新する。
     */
    if (isActive) {
        const updateResult = await client.models.UserDeviceSession.update({
            userId,
            lastCheckedAt: new Date().toISOString(),
        });

        if (updateResult.errors) {
            /*
             * lastCheckedAt更新失敗だけでは
             * セッション無効とは扱わない。
             */
            console.warn(
                "[DeviceSession] Update lastCheckedAt errors:",
                updateResult.errors,
            );
        }
    }

    return {
        success: true,
        isActive,
        message: isActive
            ? "この端末は有効です。"
            : "別の端末でログインされています。",
    };
}

/*
 * 通常ログアウト時に端末セッションを解放する。
 *
 * ただし、このdeviceIdが現在のactiveDeviceIdの場合だけ削除する。
 *
 * 古い端末が新しい端末のセッションを消してしまうことを防ぐ。
 */
async function releaseMyDeviceSession(event: any) {
    const userId = getCallerUserId(event);

    const deviceId = event.arguments.deviceId;

    const result = await client.models.UserDeviceSession.get({
        userId,
    });

    if (result.errors) {
        console.error("[DeviceSession] Release get errors:", result.errors);

        throw new Error("端末セッションを確認できませんでした。");
    }

    const session = result.data;

    if (!session) {
        return {
            success: true,
            isActive: false,
            message: "端末セッションはありません。",
        };
    }

    /*
     * 現在有効な端末以外からのreleaseは無視する。
     */
    if (session.activeDeviceId !== deviceId) {
        return {
            success: true,
            isActive: false,
            message: "この端末はすでに無効です。",
        };
    }

    const deleteResult = await client.models.UserDeviceSession.delete({
        userId,
    });

    if (deleteResult.errors) {
        console.error(
            "[DeviceSession] Delete session errors:",
            deleteResult.errors,
        );

        throw new Error("端末セッションを削除できませんでした。");
    }

    return {
        success: true,
        isActive: false,
        message: "端末セッションを終了しました。",
    };
}

export const handler = async (event: any) => {
    const operation =
        event?.fieldName ??
        event?.info?.fieldName ??
        event?.requestContext?.fieldName ??
        null;

    console.log("[DeviceSessionApi] operation:", operation);

    switch (operation) {
        case "activateMyDeviceSession":
            return await activateMyDeviceSession(event);

        case "checkMyDeviceSession":
            return await checkMyDeviceSession(event);

        case "releaseMyDeviceSession":
            return await releaseMyDeviceSession(event);

        default:
            throw new Error(`Unsupported operation: ${operation ?? "unknown"}`);
    }
};
