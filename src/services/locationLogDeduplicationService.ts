import AsyncStorage from "@react-native-async-storage/async-storage";
import type * as Location from "expo-location";

import { client } from "../lib/client";

const LOCATION_LOG_SAVE_LOCK_STORAGE_KEY =
    "location-tracker-location-log-save-lock";

const LOCK_TTL_MS = 15_000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_MAX_RETRY_COUNT = 100;

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

    for (let attempt = 0; attempt < LOCK_MAX_RETRY_COUNT; attempt += 1) {
        const now = Date.now();
        const current = await readLockRecord();

        if (!current || current.expiresAt <= now) {
            const next: LocationSaveLockRecord = {
                scopeKey,
                token,
                expiresAt: now + LOCK_TTL_MS,
            };

            await AsyncStorage.setItem(
                LOCATION_LOG_SAVE_LOCK_STORAGE_KEY,
                JSON.stringify(next),
            );

            const confirmed = await readLockRecord();

            if (confirmed?.scopeKey === scopeKey && confirmed.token === token) {
                return {
                    scopeKey,
                    token,
                };
            }
        }

        await sleep(LOCK_RETRY_INTERVAL_MS);
    }

    return null;
}

export async function releaseLocationSaveLock(
    lock: LocationSaveLock | null,
): Promise<void> {
    if (!lock) {
        return;
    }

    const current = await readLockRecord();

    if (current?.scopeKey === lock.scopeKey && current.token === lock.token) {
        await AsyncStorage.removeItem(LOCATION_LOG_SAVE_LOCK_STORAGE_KEY);
    }
}

export async function clearLocationSaveLock(): Promise<void> {
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

function sleep(milliseconds: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}
