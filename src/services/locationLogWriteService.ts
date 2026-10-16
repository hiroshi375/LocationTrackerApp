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
