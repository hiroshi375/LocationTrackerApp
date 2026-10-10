import { client } from "../lib/client";
import { getLiveLocationId } from "./liveLocationIdentityService";

/**
 * LiveLocation共有状態
 */
export type LiveLocationSharingState = {
    revision: number;
    enabled: boolean;
    sharedOwners: string[];
};

/**
 * Foreground / Background共通の位置更新Payload
 *
 * expectedRevisionはCallback開始時点で
 * 保持していた共有世代を指定する。
 */
export type LiveLocationPayload = {
    userId: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    updatedAt: string;
    sharedOwners: string[];

    // Step 2で追加
    expectedRevision: number;
};

export type LiveLocationSharingStateParams = {
    userId: string;
    legacyLiveLocationId?: string | null;
    continueSharing: boolean;
    sharedOwners?: string[];

    // Step 2で追加
    expectedRevision: number;
};

function assertRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error("INVALID_SHARE_REVISION");
    }
}

function normalizeOwners(owners: string[]): string[] {
    return Array.from(
        new Set(
            owners.filter(
                (value) => typeof value === "string" && value.trim().length > 0,
            ),
        ),
    );
}

function assertGraphQLResult(
    errors: readonly unknown[] | undefined | null,
    operation: string,
): void {
    if (errors?.length) {
        throw new Error(`${operation}: ${JSON.stringify(errors)}`);
    }
}

type GraphQLDataResult = {
    data: unknown;
    errors?: readonly unknown[];
};

function isGraphQLDataResult(value: unknown): value is GraphQLDataResult {
    return typeof value === "object" && value !== null && "data" in value;
}

function requireGraphQLData(result: unknown, operation: string): unknown {
    if (!isGraphQLDataResult(result)) {
        throw new Error(`${operation}: unexpected response type`);
    }

    if (result.errors?.length) {
        throw new Error(`${operation}: ${JSON.stringify(result.errors)}`);
    }

    if (result.data === null || result.data === undefined) {
        throw new Error(`${operation}: no data returned`);
    }

    return result.data;
}

/**
 * Cloud上の最新共有状態を取得する。
 *
 * 共有設定の操作前などに使用する。
 * 位置更新Callback内で無条件に呼んではいけない。
 */
export async function getLiveLocationSharingState(): Promise<LiveLocationSharingState> {
    const result = await client.queries.getLiveLocationSharingState({});

    if (!isGraphQLDataResult(result)) {
        throw new Error(
            "getLiveLocationSharingState: unexpected response type",
        );
    }

    assertGraphQLResult(result.errors, "getLiveLocationSharingState");

    const data = result.data;

    if (
        typeof data !== "object" ||
        data === null ||
        !("revision" in data) ||
        !("enabled" in data) ||
        !("sharedOwners" in data)
    ) {
        throw new Error("LIVE_LOCATION_STATE_NOT_RETURNED");
    }

    const revision = data.revision;

    if (typeof revision !== "number") {
        throw new Error("INVALID_SHARE_REVISION");
    }

    assertRevision(revision);

    if (typeof data.enabled !== "boolean") {
        throw new Error("INVALID_SHARE_ENABLED");
    }

    if (
        !Array.isArray(data.sharedOwners) ||
        !data.sharedOwners.every((value: unknown) => typeof value === "string")
    ) {
        throw new Error("INVALID_SHARED_OWNERS");
    }

    return {
        revision,
        enabled: data.enabled,
        sharedOwners: normalizeOwners(data.sharedOwners as string[]),
    };
}

/**
 * 現在地のみ更新する。
 *
 * - 共有先は変更しない
 * - 共有状態は変更しない
 * - 古い共有世代の更新はサーバー側で拒否される
 *
 * 戻り値は従来どおり固定LiveLocation ID。
 */
export async function upsertLiveLocation(
    payload: LiveLocationPayload,
): Promise<string> {
    assertRevision(payload.expectedRevision);

    const result = await client.mutations.updateLiveLocationCoordinates({
        expectedRevision: payload.expectedRevision,
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy: payload.accuracy,
    });

    const data = requireGraphQLData(result, "updateLiveLocationCoordinates");

    if (data !== true) {
        throw new Error("LIVE_LOCATION_COORDINATES_UPDATE_NOT_CONFIRMED");
    }

    return getLiveLocationId(payload.userId);
}

/**
 * 共有先の変更・停止・再開。
 *
 * expectedRevisionは呼び出し側から渡す。
 * 内部で自動再取得・自動リトライしない。
 */
export async function changeLiveLocationSharing(
    sharedOwners: string[],
    expectedRevision: number,
): Promise<number> {
    assertRevision(expectedRevision);

    const normalizedOwners = normalizeOwners(sharedOwners);

    const result = await client.mutations.changeLiveLocationSharing({
        expectedRevision,
        sharedOwners: normalizedOwners,
    });

    // GraphQL応答の型とエラーをまとめて検証
    const data = requireGraphQLData(result, "changeLiveLocationSharing");

    // Mutationの戻り値はnumberでなければならない
    if (typeof data !== "number") {
        throw new Error("LIVE_LOCATION_SHARING_UPDATE_NOT_CONFIRMED");
    }

    assertRevision(data);

    // 共有世代が更新されていることを確認
    if (data <= expectedRevision) {
        throw new Error("LIVE_LOCATION_SHARING_REVISION_NOT_ADVANCED");
    }

    return data;
}

/**
 * 完全共有停止。
 *
 * 対象ユーザーの固定IDをサーバー側で更新する。
 * 旧ランダムIDの失効は別途移行処理が必要。
 */
export async function deactivateLiveLocation(
    userId: string,
    expectedRevision: number,
): Promise<void> {
    if (!userId) {
        throw new Error("LIVE_LOCATION_USER_ID_REQUIRED");
    }

    await changeLiveLocationSharing([], expectedRevision);
}

/**
 * 記録停止時の共有状態変更。
 *
 * 共有終了の場合はsharedOwnersを空にする。
 * 共有継続時は共有先を保持する。
 *
 * 注意：
 * この関数は共有状態を変更する。
 * 自動記録のisRecording=false更新とは別処理。
 */
export async function setLiveLocationSharingState({
    userId,
    legacyLiveLocationId = null,
    continueSharing,
    sharedOwners = [],
    expectedRevision,
}: LiveLocationSharingStateParams): Promise<void> {
    if (!userId) {
        throw new Error("LIVE_LOCATION_USER_ID_REQUIRED");
    }

    assertRevision(expectedRevision);

    const normalizedOwners = normalizeOwners(sharedOwners);

    const nextOwners = continueSharing ? normalizedOwners : [];

    if (
        legacyLiveLocationId &&
        legacyLiveLocationId !== getLiveLocationId(userId)
    ) {
        throw new Error("LEGACY_LIVE_LOCATION_REVOCATION_REQUIRED");
    }

    await changeLiveLocationSharing(nextOwners, expectedRevision);
}

/**
 * LiveLocationの自動記録状態を開始する。
 *
 * 共有先・共有世代・座標は変更しない。
 */
export async function startLiveLocationRecording({
    expectedRevision,
    recordingSessionId,
}: {
    expectedRevision: number;
    recordingSessionId: string;
}): Promise<void> {
    assertRevision(expectedRevision);

    if (expectedRevision < 1) {
        throw new Error("INVALID_SHARE_REVISION");
    }

    if (!recordingSessionId) {
        throw new Error("RECORDING_SESSION_ID_REQUIRED");
    }

    const result = await client.mutations.startLiveLocationRecording({
        expectedRevision,
        recordingSessionId,
    });

    const data = requireGraphQLData(result, "startLiveLocationRecording");

    if (data !== true) {
        throw new Error("LIVE_LOCATION_RECORDING_START_NOT_CONFIRMED");
    }
}

/**
 * 自動記録だけを停止する。
 *
 * 現在地共有は継続し、
 * sharedOwners / shareRevision は変更しない。
 */
export async function stopLiveLocationRecording({
    expectedRevision,
    expectedRecordingSessionId,
}: {
    expectedRevision: number;
    expectedRecordingSessionId: string;
}): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error("INVALID_SHARE_REVISION");
    }

    if (!expectedRecordingSessionId) {
        throw new Error("RECORDING_SESSION_ID_REQUIRED");
    }

    const result = await client.mutations.stopLiveLocationRecording({
        expectedRevision,
        expectedRecordingSessionId,
    });

    const data = requireGraphQLData(result, "stopLiveLocationRecording");

    if (data !== true) {
        throw new Error("LIVE_LOCATION_RECORDING_STOP_NOT_CONFIRMED");
    }
}
