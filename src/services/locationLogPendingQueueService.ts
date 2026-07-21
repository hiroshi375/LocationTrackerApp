import AsyncStorage from "@react-native-async-storage/async-storage";

import { client } from "../lib/client";
import {
    calculateDistanceMeters,
    NEAR_DUPLICATE_DISTANCE_METERS,
    NEAR_DUPLICATE_TIME_MS,
} from "../utils/locationDuplicate";
import {
    createLocationLogId,
    createLocationUniqueKey,
    isDuplicateLocationCreateError,
} from "./locationLogDeduplicationService";

const PENDING_LOCATION_LOG_QUEUE_STORAGE_KEY =
    "location-tracker-pending-location-log-queue-v1";

const PENDING_LOCATION_LOG_QUEUE_VERSION = 1;
const DEFAULT_MAX_ITEMS_PER_FLUSH = 20;
const DEFAULT_FLUSH_TIME_BUDGET_MS = 20_000;
const LOCATION_LOG_CREATE_TIMEOUT_MS = 15_000;
const FAILED_FLUSH_COOLDOWN_MS = 3_000;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;

export type PendingLocationLogSource = "foreground" | "background";

export type PendingLocationLogInput = {
    userId: string;
    recordingSessionId: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: string;
    source: PendingLocationLogSource;
    sharedOwners?: string[];
    batteryLevel?: number | null;
    batteryState?: string | null;
    lowPowerMode?: boolean | null;
};

export type PendingLocationLogItem = PendingLocationLogInput & {
    id: string;
    locationUniqueKey: string;
    enqueuedAt: string;
    attemptCount: number;
    lastAttemptAt?: string | null;
    lastErrorMessage?: string | null;
};

type PendingLocationLogQueueState = {
    version: number;
    items: PendingLocationLogItem[];
};

export type EnqueuePendingLocationLogResult = {
    enqueued: boolean;
    item: PendingLocationLogItem;
    queueLength: number;
};

export type FlushPendingLocationLogsOptions = {
    force?: boolean;
    maxItems?: number;
    timeBudgetMs?: number;
    recordingSessionId?: string | null;
};

export type FlushPendingLocationLogsResult = {
    attemptedCount: number;
    syncedCount: number;
    duplicateCount: number;
    failedCount: number;
    remainingCount: number;
    timedOut: boolean;
    skippedByCooldown: boolean;
    lastErrorMessage?: string | null;
};

let queueOperationChain: Promise<unknown> = Promise.resolve();
let activeFlushPromise: Promise<FlushPendingLocationLogsResult> | null = null;
let nextFlushAllowedAtMs = 0;

/*
 * withTimeoutで待機を打ち切ってもAmplifyのcreate自体はキャンセルされない。
 * 同じLocationLogに対する未完了リクエストを重複起動しないよう、
 * 実リクエストのPromiseをid単位で保持する。
 */
const inFlightLocationLogCreatePromises = new Map<string, Promise<any>>();

export async function enqueuePendingLocationLog(
    input: PendingLocationLogInput,
): Promise<EnqueuePendingLocationLogResult> {
    validatePendingLocationLogInput(input);

    const normalizedSharedOwners = Array.from(
        new Set((input.sharedOwners ?? []).filter(Boolean)),
    );

    const locationUniqueKey = createLocationUniqueKey({
        userId: input.userId,
        recordingSessionId: input.recordingSessionId,
        recordedAt: input.recordedAt,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy ?? null,
    });

    const id = createLocationLogId(locationUniqueKey);

    const item: PendingLocationLogItem = {
        ...input,
        accuracy: input.accuracy ?? null,
        sharedOwners: normalizedSharedOwners,
        batteryLevel: input.batteryLevel ?? null,
        batteryState: input.batteryState ?? null,
        lowPowerMode: input.lowPowerMode ?? null,
        id,
        locationUniqueKey,
        enqueuedAt: new Date().toISOString(),
        attemptCount: 0,
        lastAttemptAt: null,
        lastErrorMessage: null,
    };

    return withQueueOperation(async () => {
        const queue = await readQueueStateUnsafe();
        const existingItem = queue.items.find((currentItem) => {
            if (currentItem.id === item.id) {
                return true;
            }

            if (
                currentItem.userId !== item.userId ||
                currentItem.recordingSessionId !== item.recordingSessionId
            ) {
                return false;
            }

            const elapsedMs = Math.abs(
                new Date(currentItem.recordedAt).getTime() -
                    new Date(item.recordedAt).getTime(),
            );

            if (elapsedMs > NEAR_DUPLICATE_TIME_MS) {
                return false;
            }

            const distanceMeters = calculateDistanceMeters(
                currentItem.latitude,
                currentItem.longitude,
                item.latitude,
                item.longitude,
            );

            return distanceMeters <= NEAR_DUPLICATE_DISTANCE_METERS;
        });

        if (existingItem) {
            return {
                enqueued: false,
                item: existingItem,
                queueLength: queue.items.length,
            };
        }

        const nextItems = [...queue.items, item].sort(comparePendingItems);

        await writeQueueStateUnsafe({
            version: PENDING_LOCATION_LOG_QUEUE_VERSION,
            items: nextItems,
        });

        return {
            enqueued: true,
            item,
            queueLength: nextItems.length,
        };
    });
}

export async function enqueuePendingLocationLogs(
    inputs: PendingLocationLogInput[],
): Promise<EnqueuePendingLocationLogResult[]> {
    const results: EnqueuePendingLocationLogResult[] = [];

    for (const input of inputs) {
        results.push(await enqueuePendingLocationLog(input));
    }

    return results;
}

export async function flushPendingLocationLogs(
    options: FlushPendingLocationLogsOptions = {},
): Promise<FlushPendingLocationLogsResult> {
    if (activeFlushPromise) {
        const activeResult = await activeFlushPromise;

        if (!options.force) {
            return activeResult;
        }
    }

    if (!options.force && Date.now() < nextFlushAllowedAtMs) {
        return {
            attemptedCount: 0,
            syncedCount: 0,
            duplicateCount: 0,
            failedCount: 0,
            remainingCount: await getPendingLocationLogCount(
                options.recordingSessionId,
            ),
            timedOut: false,
            skippedByCooldown: true,
            lastErrorMessage: null,
        };
    }

    const flushPromise = performFlushPendingLocationLogs(options).finally(
        () => {
            if (activeFlushPromise === flushPromise) {
                activeFlushPromise = null;
            }
        },
    );

    activeFlushPromise = flushPromise;
    return flushPromise;
}

export async function getPendingLocationLogCount(
    recordingSessionId?: string | null,
): Promise<number> {
    return withQueueOperation(async () => {
        const queue = await readQueueStateUnsafe();

        if (!recordingSessionId) {
            return queue.items.length;
        }

        return queue.items.filter(
            (item) => item.recordingSessionId === recordingSessionId,
        ).length;
    });
}

export async function removePendingLocationLogsBySessionId(
    recordingSessionId: string,
): Promise<number> {
    if (!recordingSessionId) {
        return 0;
    }

    return withQueueOperation(async () => {
        const queue = await readQueueStateUnsafe();
        const nextItems = queue.items.filter(
            (item) => item.recordingSessionId !== recordingSessionId,
        );
        const removedCount = queue.items.length - nextItems.length;

        if (removedCount > 0) {
            await writeQueueStateUnsafe({
                version: PENDING_LOCATION_LOG_QUEUE_VERSION,
                items: nextItems,
            });
        }

        return removedCount;
    });
}

async function performFlushPendingLocationLogs(
    options: FlushPendingLocationLogsOptions,
): Promise<FlushPendingLocationLogsResult> {
    const startedAtMs = Date.now();
    const maxItems = normalizePositiveInteger(
        options.maxItems,
        DEFAULT_MAX_ITEMS_PER_FLUSH,
    );
    const timeBudgetMs = normalizePositiveInteger(
        options.timeBudgetMs,
        DEFAULT_FLUSH_TIME_BUDGET_MS,
    );

    let attemptedCount = 0;
    let syncedCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;
    let timedOut = false;
    let lastErrorMessage: string | null = null;

    const queueSnapshot = await readQueueSnapshot();
    const targetItems = queueSnapshot
        .filter((item) => {
            return options.recordingSessionId
                ? item.recordingSessionId === options.recordingSessionId
                : true;
        })
        .sort(comparePendingItems)
        .slice(0, maxItems);

    for (const item of targetItems) {
        const elapsedMs = Date.now() - startedAtMs;
        const remainingBudgetMs = timeBudgetMs - elapsedMs;

        if (remainingBudgetMs <= 250) {
            timedOut = true;
            break;
        }

        attemptedCount += 1;

        try {
            await markPendingLocationLogAttempt(item.id, null, true);

            const requestTimeoutMs = Math.max(
                250,
                Math.min(LOCATION_LOG_CREATE_TIMEOUT_MS, remainingBudgetMs),
            );

            const result = await withTimeout<any>(
                getOrCreateLocationLogRequest(item),
                requestTimeoutMs,
                `LocationLog create timed out after ${requestTimeoutMs}ms.`,
            );

            if (result.errors) {
                if (isDuplicateLocationCreateError(result.errors)) {
                    duplicateCount += 1;
                    await removePendingLocationLogById(item.id);
                    continue;
                }

                throw new Error(toErrorMessage(result.errors));
            }

            syncedCount += 1;
            await removePendingLocationLogById(item.id);
        } catch (error) {
            failedCount += 1;
            lastErrorMessage = truncateText(
                toErrorMessage(error),
                MAX_ERROR_MESSAGE_LENGTH,
            );

            await markPendingLocationLogAttempt(
                item.id,
                lastErrorMessage,
                false,
            );

            nextFlushAllowedAtMs = Date.now() + FAILED_FLUSH_COOLDOWN_MS;
            break;
        }
    }

    const remainingCount = await getPendingLocationLogCount(
        options.recordingSessionId,
    );

    if (failedCount === 0) {
        nextFlushAllowedAtMs = 0;
    }

    return {
        attemptedCount,
        syncedCount,
        duplicateCount,
        failedCount,
        remainingCount,
        timedOut,
        skippedByCooldown: false,
        lastErrorMessage,
    };
}

function getOrCreateLocationLogRequest(
    item: PendingLocationLogItem,
): Promise<any> {
    const existingPromise = inFlightLocationLogCreatePromises.get(item.id);

    if (existingPromise) {
        return existingPromise;
    }

    const createPromise = (client.models.LocationLog as any)
        .create(createLocationLogPayload(item))
        .finally(() => {
            if (
                inFlightLocationLogCreatePromises.get(item.id) === createPromise
            ) {
                inFlightLocationLogCreatePromises.delete(item.id);
            }
        });

    inFlightLocationLogCreatePromises.set(item.id, createPromise);
    return createPromise;
}

function createLocationLogPayload(item: PendingLocationLogItem) {
    return {
        id: item.id,
        userId: item.userId,
        latitude: item.latitude,
        longitude: item.longitude,
        accuracy: item.accuracy ?? null,
        recordedAt: item.recordedAt,
        memo: "自動記録",
        recordingSessionId: item.recordingSessionId,
        source: item.source,
        sharedOwners:
            item.sharedOwners && item.sharedOwners.length > 0
                ? item.sharedOwners
                : undefined,
        locationUniqueKey: item.locationUniqueKey,
        batteryLevel: item.batteryLevel ?? undefined,
        batteryState: item.batteryState ?? undefined,
        lowPowerMode: item.lowPowerMode ?? undefined,
    };
}

async function readQueueSnapshot(): Promise<PendingLocationLogItem[]> {
    return withQueueOperation(async () => {
        const queue = await readQueueStateUnsafe();
        return [...queue.items];
    });
}

async function removePendingLocationLogById(id: string): Promise<void> {
    await withQueueOperation(async () => {
        const queue = await readQueueStateUnsafe();
        const nextItems = queue.items.filter((item) => item.id !== id);

        if (nextItems.length === queue.items.length) {
            return;
        }

        await writeQueueStateUnsafe({
            version: PENDING_LOCATION_LOG_QUEUE_VERSION,
            items: nextItems,
        });
    });
}

async function markPendingLocationLogAttempt(
    id: string,
    errorMessage: string | null,
    incrementAttemptCount: boolean,
): Promise<void> {
    await withQueueOperation(async () => {
        const queue = await readQueueStateUnsafe();
        let changed = false;

        const nextItems = queue.items.map((item) => {
            if (item.id !== id) {
                return item;
            }

            changed = true;

            return {
                ...item,
                attemptCount:
                    item.attemptCount + (incrementAttemptCount ? 1 : 0),
                lastAttemptAt: new Date().toISOString(),
                lastErrorMessage: errorMessage,
            };
        });

        if (!changed) {
            return;
        }

        await writeQueueStateUnsafe({
            version: PENDING_LOCATION_LOG_QUEUE_VERSION,
            items: nextItems,
        });
    });
}

async function readQueueStateUnsafe(): Promise<PendingLocationLogQueueState> {
    const raw = await AsyncStorage.getItem(
        PENDING_LOCATION_LOG_QUEUE_STORAGE_KEY,
    );

    if (!raw) {
        return {
            version: PENDING_LOCATION_LOG_QUEUE_VERSION,
            items: [],
        };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `Pending LocationLog queue JSON is invalid: ${toErrorMessage(error)}`,
        );
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
        throw new Error("Pending LocationLog queue format is invalid.");
    }

    const items: PendingLocationLogItem[] = [];

    for (const rawItem of parsed.items) {
        const normalizedItem = normalizePendingLocationLogItem(rawItem);

        if (!normalizedItem) {
            throw new Error(
                "Pending LocationLog queue contains an invalid item.",
            );
        }

        items.push(normalizedItem);
    }

    items.sort(comparePendingItems);

    return {
        version: PENDING_LOCATION_LOG_QUEUE_VERSION,
        items,
    };
}

async function writeQueueStateUnsafe(
    state: PendingLocationLogQueueState,
): Promise<void> {
    await AsyncStorage.setItem(
        PENDING_LOCATION_LOG_QUEUE_STORAGE_KEY,
        JSON.stringify({
            version: PENDING_LOCATION_LOG_QUEUE_VERSION,
            items: state.items.sort(comparePendingItems),
        }),
    );
}

function normalizePendingLocationLogItem(
    value: unknown,
): PendingLocationLogItem | null {
    if (!isRecord(value)) {
        return null;
    }

    if (
        typeof value.id !== "string" ||
        typeof value.locationUniqueKey !== "string" ||
        typeof value.userId !== "string" ||
        typeof value.recordingSessionId !== "string" ||
        typeof value.latitude !== "number" ||
        !Number.isFinite(value.latitude) ||
        typeof value.longitude !== "number" ||
        !Number.isFinite(value.longitude) ||
        typeof value.recordedAt !== "string" ||
        !Number.isFinite(new Date(value.recordedAt).getTime()) ||
        (value.source !== "foreground" && value.source !== "background")
    ) {
        return null;
    }

    return {
        id: value.id,
        locationUniqueKey: value.locationUniqueKey,
        userId: value.userId,
        recordingSessionId: value.recordingSessionId,
        latitude: value.latitude,
        longitude: value.longitude,
        accuracy:
            typeof value.accuracy === "number" &&
            Number.isFinite(value.accuracy)
                ? value.accuracy
                : null,
        recordedAt: value.recordedAt,
        source: value.source,
        sharedOwners: Array.isArray(value.sharedOwners)
            ? value.sharedOwners.filter(
                  (owner): owner is string =>
                      typeof owner === "string" && owner.length > 0,
              )
            : [],
        batteryLevel:
            typeof value.batteryLevel === "number" &&
            Number.isFinite(value.batteryLevel)
                ? value.batteryLevel
                : null,
        batteryState:
            typeof value.batteryState === "string" ? value.batteryState : null,
        lowPowerMode:
            typeof value.lowPowerMode === "boolean" ? value.lowPowerMode : null,
        enqueuedAt:
            typeof value.enqueuedAt === "string"
                ? value.enqueuedAt
                : new Date().toISOString(),
        attemptCount:
            typeof value.attemptCount === "number" &&
            Number.isInteger(value.attemptCount) &&
            value.attemptCount >= 0
                ? value.attemptCount
                : 0,
        lastAttemptAt:
            typeof value.lastAttemptAt === "string"
                ? value.lastAttemptAt
                : null,
        lastErrorMessage:
            typeof value.lastErrorMessage === "string"
                ? value.lastErrorMessage
                : null,
    };
}

function validatePendingLocationLogInput(input: PendingLocationLogInput): void {
    if (!input.userId) {
        throw new Error("Pending LocationLog userId is required.");
    }

    if (!input.recordingSessionId) {
        throw new Error("Pending LocationLog recordingSessionId is required.");
    }

    if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
        throw new Error("Pending LocationLog coordinate is invalid.");
    }

    if (!Number.isFinite(new Date(input.recordedAt).getTime())) {
        throw new Error("Pending LocationLog recordedAt is invalid.");
    }
}

function comparePendingItems(
    left: PendingLocationLogItem,
    right: PendingLocationLogItem,
): number {
    const timeDiff =
        new Date(left.recordedAt).getTime() -
        new Date(right.recordedAt).getTime();

    if (timeDiff !== 0) {
        return timeDiff;
    }

    return left.id.localeCompare(right.id);
}

function withQueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const nextOperation = queueOperationChain.then(operation, operation);

    queueOperationChain = nextOperation.then(
        () => undefined,
        () => undefined,
    );

    return nextOperation;
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timerId = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timerId);
                resolve(value);
            },
            (error) => {
                clearTimeout(timerId);
                reject(error);
            },
        );
    });
}

function normalizePositiveInteger(
    value: number | undefined,
    fallback: number,
): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === "string") {
        return error;
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function truncateText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null;
}
