import { client } from "../lib/client";
import { getLiveLocationId } from "./liveLocationIdentityService";

export type LiveLocationPayload = {
    userId: string;
    recordingSessionId: string | null;
    isRecording: boolean;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    updatedAt: string;
    sharedOwners: string[];
};

type MutationResult = {
    data?: { id?: string | null } | null;
    errors?: readonly unknown[] | null;
};

/**
 * AmplifyがGraphQL errorsを返した場合も失敗扱いにする。
 */
function assertMutationSucceeded(
    result: MutationResult,
    operation: string,
): void {
    if (
        result.errors &&
        (!Array.isArray(result.errors) || result.errors.length > 0)
    ) {
        throw new Error(`${operation}: ${JSON.stringify(result.errors)}`);
    }

    if (!result.data?.id) {
        throw new Error(`${operation}: no record returned`);
    }
}

/**
 * Cloudに既存レコードがあるかを確認する。
 *
 * 通信エラーや認可エラーは「存在しない」と扱わない。
 */
export async function upsertLiveLocation(
    payload: LiveLocationPayload,
): Promise<string> {
    const id = getLiveLocationId(payload.userId);
    const model = client.models.LiveLocation as any;

    const existing = await model.get({ id });

    if (existing.errors?.length) {
        throw new Error(
            `LiveLocation.get failed: ${JSON.stringify(existing.errors)}`,
        );
    }

    if (existing.data) {
        const result = (await model.update({
            id,
            ...payload,
            isActive: true,
        })) as MutationResult;

        assertMutationSucceeded(result, "LiveLocation.update");
        return id;
    }

    /*
     * IDを指定して作成する。
     * 複数の処理が同時にcreateしても、別IDのレコードは
     * 増えない。
     */
    const result = (await model.create({
        id,
        ...payload,
        isActive: true,
    })) as MutationResult;

    if (result.data?.id && !result.errors?.length) {
        return id;
    }

    /*
     * createの結果が不明な場合は別IDで再作成しない。
     * 次回の処理で同じIDを確認する。
     */
    throw new Error(
        `LiveLocation.create not confirmed: ${JSON.stringify(
            result.errors ?? ["no record returned"],
        )}`,
    );
}

export async function deactivateLiveLocation(userId: string): Promise<void> {
    const id = getLiveLocationId(userId);
    const model = client.models.LiveLocation as any;

    const existing = await model.get({ id });

    if (existing.errors?.length) {
        throw new Error(
            `LiveLocation.get failed: ${JSON.stringify(existing.errors)}`,
        );
    }

    if (!existing.data) {
        return;
    }

    const result = (await model.update({
        id,
        isActive: false,
        isRecording: false,
        recordingSessionId: null,
        sharedOwners: [],
        updatedAt: new Date().toISOString(),
    })) as MutationResult;

    assertMutationSucceeded(result, "LiveLocation.deactivate");
}
