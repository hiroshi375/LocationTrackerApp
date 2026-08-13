import AsyncStorage from "@react-native-async-storage/async-storage";
import type * as Location from "expo-location";

import { client } from "../lib/client";

const LOCATION_LOG_SAVE_LOCK_STORAGE_KEY =
    "location-tracker-location-log-save-lock";

/*
 * LocationLog direct保存用ロック。
 *
 * 重要：
 * ロックが使用中の場合は待機しない。
 *
 * OSから受信した地点はbackgroundLocationTask側で
 * 先にSQLiteへ保存されているため、
 * direct保存が競合した場合はSQLite再送へ任せる。
 *
 * これにより、background callbackが
 * ロック待ちで数分～数十分滞留することを防ぐ。
 */
const LOCK_TTL_MS = 30_000;

/*
 * 同一JS runtime内ではAsyncStorageより先に
 * メモリ上で排他する。
 *
 * AsyncStorageのread → write → readだけでは
 * 完全なatomic lockにはならないため、
 * 同一runtime内の同時処理をここで即座に防止する。
 */
const activeLocationSaveLocks = new Map<string, string>();

type LocationSaveLockRecord = {
    scopeKey: string;
    token: string;
    expiresAt: number;
};

export type LocationSaveLock = {
    scopeKey: string;
    token: string;
};

type LocationIdentityInput = {
    userId: string;
    recordingSessionId: string;
    recordedAt: string;
    latitude: number;
    longitude: number;
    accuracy: number | null | undefined;
};

/*
 * foreground/backgroundで完全に同じ値を生成する。
 * sourceは含めないため、両経路から同じ位置が来ても同一レコードになる。
 */
export function createLocationUniqueKey({
    userId,
    recordingSessionId,
    recordedAt,
    latitude,
    longitude,
    accuracy,
}: LocationIdentityInput) {
    return [
        userId,
        recordingSessionId,
        recordedAt,
        normalizeCoordinate(latitude),
        normalizeCoordinate(longitude),
        normalizeAccuracy(accuracy),
    ].join("#");
}

/*
 * DynamoDBの主キーにも同じ決定的な値を使用する。
 * 同時実行で事前確認をすり抜けても、同じidの2件目は作成できない。
 */
export function createLocationLogId(locationUniqueKey: string) {
    return `location#${locationUniqueKey}`;
}

export function createLocationSaveLockScopeKey(
    userId: string,
    recordingSessionId: string,
) {
    return `${userId}#${recordingSessionId}`;
}

export async function acquireLocationSaveLock(
    scopeKey: string,
): Promise<LocationSaveLock | null> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

    /*
     * 同一JS runtime内で既に同じセッションの保存処理が動いているなら、
     * 待機せず即座に諦める。
     *
     * background側では対象地点が先にSQLiteへ保存されているため、
     * 後からSQLite queueで回収できる。
     */
    if (activeLocationSaveLocks.has(scopeKey)) {
        return null;
    }

    /*
     * awaitを挟む前に同期的に確保する。
     * これにより同一runtime内の別callbackが
     * AsyncStorage処理へ入ること自体を防ぐ。
     */
    activeLocationSaveLocks.set(scopeKey, token);

    try {
        const now = Date.now();

        const current = await readLockRecord();

        /*
         * 有効な永続ロックが存在する場合も待たない。
         *
         * 以前は最大100回リトライしていたが、
         * background callback滞留の原因になるため即returnする。
         */
        if (current && current.expiresAt > now) {
            activeLocationSaveLocks.delete(scopeKey);

            return null;
        }

        /*
         * ロックが存在しない、またはTTL切れの場合だけ取得を試みる。
         */
        const next: LocationSaveLockRecord = {
            scopeKey,
            token,
            expiresAt: now + LOCK_TTL_MS,
        };

        await AsyncStorage.setItem(
            LOCATION_LOG_SAVE_LOCK_STORAGE_KEY,
            JSON.stringify(next),
        );

        /*
         * AsyncStorageはatomic compare-and-setではないため、
         * 書き込み後に自分のtokenが残っていることを確認する。
         */
        const confirmed = await readLockRecord();

        if (confirmed?.scopeKey !== scopeKey || confirmed.token !== token) {
            activeLocationSaveLocks.delete(scopeKey);

            return null;
        }

        return {
            scopeKey,
            token,
        };
    } catch (error) {
        /*
         * AsyncStorageエラー時もメモリロックを残さない。
         */
        if (activeLocationSaveLocks.get(scopeKey) === token) {
            activeLocationSaveLocks.delete(scopeKey);
        }

        throw error;
    }
}

export async function releaseLocationSaveLock(
    lock: LocationSaveLock | null,
): Promise<void> {
    if (!lock) {
        return;
    }

    /*
     * まずメモリ側を解除する。
     *
     * AsyncStorage処理が遅れても、
     * JS runtime内の後続Location保存を不必要に止めない。
     */
    if (activeLocationSaveLocks.get(lock.scopeKey) === lock.token) {
        activeLocationSaveLocks.delete(lock.scopeKey);
    }

    try {
        const current = await readLockRecord();

        /*
         * 自分が所有しているロックだけ削除する。
         *
         * TTL切れ後に別処理が新しいロックを取得していた場合、
         * そのロックを誤って削除しない。
         */
        if (
            current?.scopeKey === lock.scopeKey &&
            current.token === lock.token
        ) {
            await AsyncStorage.removeItem(LOCATION_LOG_SAVE_LOCK_STORAGE_KEY);
        }
    } catch (error) {
        /*
         * 永続ロックはTTLで自動的に無効になるため、
         * release時のAsyncStorageエラーで
         * LocationLog処理全体を失敗させない。
         */
        console.warn("Release persisted location save lock failed:", error);
    }
}

export async function clearLocationSaveLock(): Promise<void> {
    /*
     * 新しい記録セッション開始時などに
     * runtime内の残留ロックも確実に破棄する。
     */
    activeLocationSaveLocks.clear();

    await AsyncStorage.removeItem(LOCATION_LOG_SAVE_LOCK_STORAGE_KEY);
}

export async function isLocationLogAlreadySaved(
    locationLogId: string,
): Promise<boolean> {
    const result = await (client.models.LocationLog as any).get({
        id: locationLogId,
    });

    if (result.errors) {
        throw new Error(JSON.stringify(result.errors));
    }

    return Boolean(result.data?.id);
}

/*
 * OSが1回のbackground callbackで同じ位置を複数返した場合に、
 * 保存処理へ渡す前に完全重複を除去する。
 */
export function deduplicateLocationBatch(
    locations: Location.LocationObject[],
): Location.LocationObject[] {
    const uniqueLocations = new Map<string, Location.LocationObject>();

    for (const location of locations) {
        const timestamp =
            typeof location.timestamp === "number" &&
            Number.isFinite(location.timestamp)
                ? location.timestamp
                : 0;

        const latitude = location.coords.latitude;
        const longitude = location.coords.longitude;
        const accuracy = location.coords.accuracy ?? null;

        const key = [
            timestamp,
            normalizeCoordinate(latitude),
            normalizeCoordinate(longitude),
            normalizeAccuracy(accuracy),
        ].join("#");

        if (!uniqueLocations.has(key)) {
            uniqueLocations.set(key, location);
        }
    }

    return Array.from(uniqueLocations.values());
}

export function isDuplicateLocationCreateError(error: unknown) {
    const text =
        typeof error === "string"
            ? error
            : (() => {
                  try {
                      return JSON.stringify(error);
                  } catch {
                      return String(error);
                  }
              })();

    return (
        text.includes("ConditionalCheckFailed") ||
        text.includes("The conditional request failed") ||
        text.includes("already exists")
    );
}

async function readLockRecord(): Promise<LocationSaveLockRecord | null> {
    const raw = await AsyncStorage.getItem(LOCATION_LOG_SAVE_LOCK_STORAGE_KEY);

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<LocationSaveLockRecord>;

        if (
            typeof parsed.scopeKey !== "string" ||
            typeof parsed.token !== "string" ||
            typeof parsed.expiresAt !== "number"
        ) {
            return null;
        }

        return {
            scopeKey: parsed.scopeKey,
            token: parsed.token,
            expiresAt: parsed.expiresAt,
        };
    } catch {
        return null;
    }
}

function normalizeCoordinate(value: number) {
    return Number.isFinite(value) ? value.toFixed(7) : "invalid";
}

function normalizeAccuracy(value: number | null | undefined) {
    if (value == null) {
        return "null";
    }

    return Number.isFinite(value) ? value.toFixed(3) : "invalid";
}
