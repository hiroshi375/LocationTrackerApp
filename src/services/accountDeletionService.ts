import { accountDeletionStateKey } from "./accountDeletionState";
import { deleteLocationQueueForAccount } from "./locationLocationQueueService";
import { deleteNativeRecordingInboxForAccount } from "./nativeRecordingInboxService";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { deleteUser, getCurrentUser } from "aws-amplify/auth";
import { remove } from "aws-amplify/storage";

import { client } from "../lib/client";
import { BACKGROUND_RECORDING_STATE_KEY } from "../tasks/backgroundLocationTask";
import {
    getBackgroundRecordingStatus,
    stopBackgroundLocationRecording,
} from "./backgroundLocationService";

type DeletableItem = {
    id: string;
};

type UserProfileItem = DeletableItem & {
    userId: string;
    iconImagePath?: string | null;
    ownerValue?: string | null;
};

type ListResult<T> = {
    data?: T[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

export type AccountDeletionProgress =
    | "deletingServerData"
    | "stoppingRecording"
    | "loadingProfile"
    | "deletingLocationLogs"
    | "deletingRecordingSessions"
    | "deletingLiveLocations"
    | "deletingMonthlySummaries"
    | "deletingDebugLogs"
    | "deletingProfileImage"
    | "deletingProfile"
    | "deletingLocalData"
    | "deletingCognitoUser";

type DeleteCurrentAccountOptions = {
    onProgress?: (progress: AccountDeletionProgress) => void;
};

/**
 * 現在ログイン中のユーザーと、そのユーザーが所有する関連データを削除する。
 *
 * Cognitoユーザーは必ず最後に削除する。
 * 先にCognitoを削除すると、その後のData／Storage削除が認証エラーになる。
 */
export async function deleteCurrentAccount(
    options: DeleteCurrentAccountOptions = {},
): Promise<void> {
    const { onProgress } = options;

    const currentUser = await getCurrentUser();
    const userId = currentUser.userId;

    /*
     * 1. バックグラウンド記録を停止
     */
    onProgress?.("stoppingRecording");

    const recordingStatus = await getBackgroundRecordingStatus();

    if (recordingStatus.state?.userId && recordingStatus.state.userId !== userId) {
        throw new Error("別アカウントの記録状態が残っています。そのアカウントで記録を停止してから削除してください。");
    }
    if (recordingStatus.hasStarted || recordingStatus.state) {
        await stopBackgroundLocationRecording();
    }

    /*
     * 2. UserProfileを先に取得
     *
     * S3画像パスはUserProfileを削除する前に取得しておく。
     */
    onProgress?.("loadingProfile");

    const userProfiles = await listAllByUserId<UserProfileItem>(
        client.models.UserProfile as any,
        userId,
        "UserProfile",
    );

    const profileImagePaths = Array.from(
        new Set(
            userProfiles
                .map((profile) => profile.iconImagePath?.trim())
                .filter((path): path is string => Boolean(path)),
        ),
    );

    // Persist the image inventory before cloud profiles can be removed. Resume after app exit.
    const stateKey = accountDeletionStateKey(userId);
    const previousRaw = await AsyncStorage.getItem(stateKey);
    const previous = previousRaw ? JSON.parse(previousRaw) as { imagePaths?: string[] } : {};
    const allImagePaths = [...new Set([...profileImagePaths, ...(previous.imagePaths ?? [])])];
    await AsyncStorage.setItem(stateKey, JSON.stringify({ imagePaths: allImagePaths }));

    onProgress?.("deletingServerData");
    // Each call processes one durable page; a hard timeout does not lose the cursor.
    // A bounded UI wait leaves the account intact for a deliberate retry.
    const deadline = Date.now() + 10 * 60 * 1000;
    let complete = false;
    let emptyResponses = 0;
    while (Date.now() < deadline) {
        const result = await client.mutations.deleteCurrentAccountData({}) as unknown as {
            data?: { completed: boolean; phase: string } | null; errors?: readonly unknown[];
        };
        if (!result.errors?.length && !result.data && emptyResponses++ < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }
        if (result.errors?.length || !result.data) {
            throw new Error("サーバーデータの削除が完了していません。通信を確認し、アカウント削除を再実行して再開してください。");
        }
        emptyResponses = 0;
        if (result.data.completed) { complete = true; break; }
        const waiting = result.data.phase === "処理中" || result.data.phase === "実行中の記録処理の終了待ち";
        await new Promise(resolve => setTimeout(resolve, waiting ? 1000 : 150));
    }
    if (!complete) throw new Error("削除処理の進捗を保存しました。アカウント削除を再実行して続きから再開してください。");

    /*
     * 8. S3プロフィール画像を削除
     *
     * Storage認可では、本人のidentity配下にdelete権限があります。
     */
    onProgress?.("deletingProfileImage");

    for (const imagePath of allImagePaths) {
        await deleteProfileImage(imagePath);
    }

    /*
     * 9. UserProfileを削除
     */
    onProgress?.("deletingProfile");

    await deleteItems(
        client.models.UserProfile as any,
        userProfiles,
        "UserProfile",
    );

    /*
     * 10. AsyncStorageのアプリ固有データを削除
     *
     * AsyncStorage.clear()は使わない。
     * Amplify Auth内部の認証データまで消えるとdeleteUser()が失敗するため。
     */
    onProgress?.("deletingLocalData");

    await deleteNativeRecordingInboxForAccount(userId);
    await deleteLocationQueueForAccount(userId);
    await removeLocationTrackerStorageKeys();

    /*
     * 11. 最後にCognitoユーザーを削除
     *
     * 成功すると認証状態が解除される。
     */
    onProgress?.("deletingCognitoUser");

    await deleteUser();
    await AsyncStorage.removeItem(stateKey);
}

async function listAllByUserId<T extends DeletableItem>(
    model: any,
    userId: string,
    modelName: string,
): Promise<T[]> {
    const allItems: T[] = [];
    let nextToken: string | null = null;

    do {
        const result = (await model.list({
            filter: {
                userId: {
                    eq: userId,
                },
            },
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as ListResult<T>;

        if (Array.isArray(result.errors) ? result.errors.length > 0 : Boolean(result.errors)) {
            console.error(`${modelName} list errors:`, result.errors);

            throw new Error(`${modelName}の取得に失敗しました。`);
        }

        allItems.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    return allItems;
}

async function deleteItems(
    model: any,
    items: DeletableItem[],
    modelName: string,
): Promise<void> {
    /*
     * 大量レコードを一度にPromise.allへ渡さないよう、
     * 20件単位で削除する。
     */
    const batchSize = 20;

    for (let index = 0; index < items.length; index += batchSize) {
        const batch = items.slice(index, index + batchSize);

        const results = await Promise.all(
            batch.map((item) =>
                model.delete({
                    id: item.id,
                }),
            ),
        );

        const errorResult = results.find((result) => result.errors?.length || !result.data);

        if (errorResult) {
            console.error(`${modelName} delete errors:`, errorResult.errors);

            throw new Error(`${modelName}の削除に失敗しました。`);
        }
    }
}

async function deleteProfileImage(imagePath: string): Promise<void> {
    try {
        await remove({
            path: imagePath,
        });
    } catch (error) {
        console.error("Profile image delete error:", {
            imagePath,
            error,
        });

        throw new Error("プロフィール画像の削除に失敗しました。");
    }
}

async function removeLocationTrackerStorageKeys(): Promise<void> {
    const allKeys = await AsyncStorage.getAllKeys();

    const keysToRemove = allKeys.filter((key) => {
        return (
            key === BACKGROUND_RECORDING_STATE_KEY ||
            key.startsWith("location-tracker-") ||
            key.startsWith("location-map-")
        );
    });

    if (keysToRemove.length === 0) {
        return;
    }

    await AsyncStorage.multiRemove(keysToRemove);
}
