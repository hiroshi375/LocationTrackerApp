import { client } from "../lib/client";

/** The server determines sharing from current grants; queued owner arrays are not authoritative. */
export async function createLocationLog(input: Record<string, unknown>) {
    const { sharedOwners: _ignored, owner: _owner, ...record } = input;
    const result = await (
        client.mutations.ingestLocationLog as (args: {
            input: string;
        }) => Promise<{
            data?: { id: string; created: boolean } | null;
            errors?: unknown[];
        }>
    )({ input: JSON.stringify(record) });
    if (result.errors?.length || !result.data)
        return {
            data: null,
            errors: result.errors?.length
                ? result.errors
                : [{ message: "位置情報保存の結果を確認できません。" }],
        };
    // Publish only a confirmed server receipt, including an idempotent replay.
    // Keep cloud success successful even if the local cache cannot be written.
    if (typeof record.userId === "string" && typeof record.recordingSessionId === "string" &&
        typeof record.latitude === "number" && typeof record.longitude === "number" &&
        typeof record.recordedAt === "string") {
        try {
            const { acceptedLocationBaselines } = await import("./acceptedLocationBaselineService");
            await acceptedLocationBaselines.record(record.userId, record.recordingSessionId, {
                latitude: record.latitude, longitude: record.longitude, recordedAt: Date.parse(record.recordedAt),
            });
        } catch (error) { console.error("Accepted location baseline cache update failed:", error); }
    }
    if (!result.data.created)
        return {
            data: null,
            errors: [
                {
                    message:
                        "ConditionalCheckFailedException: conditional request failed (already exists)",
                },
            ],
        };
    return { data: { ...record, id: result.data.id }, errors: undefined };
}
