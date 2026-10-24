import { randomUUID } from "node:crypto";
import { DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ingestLocationLog } from "./locationLogIngest";
import { accessDb, getRow, tables, type Row } from "./groupAccessStore";
import { assertRecordOwner } from "./recordOwnership";

// Field-level read restrictions remove the generated delete resolver's owner
// branch. Preserve the released API, but authorize against the stored record.
export async function deleteLegacyLocationLog(userId: string, input: Row, condition?: unknown) {
    return deleteLegacyOwnedRecord(tables.logs(), userId, input, condition);
}

export async function deleteLegacyRecordingSession(userId: string, input: Row, condition?: unknown) {
    return deleteLegacyOwnedRecord(tables.sessions(), userId, input, condition);
}

async function deleteLegacyOwnedRecord(table: string, userId: string, input: Row, condition?: unknown) {
    if (typeof input?.id !== "string" || !input.id.trim()) throw new Error("削除する記録IDがありません。");
    // Never silently discard a caller's optimistic-concurrency condition.
    if (condition != null) throw new Error("条件付き削除には対応していません。");
    const row = await getRow(table, { id: input.id });
    if (!row) return null;
    assertRecordOwner(row, userId);
    const result = await accessDb.send(new DeleteCommand({
        TableName: table, Key: { id: row.id },
        ConditionExpression: "#owner = :owner AND #userId = :userId",
        ExpressionAttributeNames: { "#owner": "owner", "#userId": "userId" },
        ExpressionAttributeValues: { ":owner": row.owner, ":userId": userId },
        ReturnValues: "ALL_OLD",
    }));
    // Session index readers already tolerate tombstones left by owner deletion.
    return result.Attributes ?? null;
}

// Released clients use generated create mutations. Route them through the same
// server-owned sharing decision as new clients; never trust queued sharedOwners.
export async function createLegacyLocationLog(userId: string, username: string, input: Row) {
    const result = await ingestLocationLog(userId, username, { ...input, id: input.id || randomUUID() });
    if (!result.created) throw new Error("ConditionalCheckFailedException: conditional request failed (already exists)");
    return getRow(tables.logs(), { id: result.id });
}
export async function createLegacyRecordingSession(userId: string, username: string, input: Row) {
    if (input.userId !== userId) throw new Error("記録所有者が一致しません。");
    const id = input.id || randomUUID();
    const operation = await getRow(tables.operations(), { recordingSessionRecordId: id });
    if (operation) throw new Error("既存の共有操作があるためセッションを作成できません。");
    if (typeof input.recordingSessionId !== "string" || !input.recordingSessionId.trim())
        throw new Error("記録セッションIDがありません。");
    const canonicalId = `recording-session:${userId}:${input.recordingSessionId}`;
    const timestamp = new Date().toISOString();
    const row = { ...input, id, owner: username ? `${userId}::${username}` : userId,
        sharedOwners: [], createdAt: timestamp, updatedAt: timestamp, __typename: "RecordingSession" };
    try {
        await accessDb.send(new TransactWriteCommand({ TransactItems: [
            { ConditionCheck: { TableName: tables.operations(), Key: { recordingSessionRecordId: canonicalId },
                ConditionExpression: "attribute_not_exists(discardOperation)" } },
            { Put: { TableName: tables.sessions(), Item: row, ConditionExpression: "attribute_not_exists(id)" } },
        ] }));
    } catch (error: any) {
        if (error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed")
            throw new Error("SESSION_DISCARDED: この記録は破棄されています。");
        if (error.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed")
            throw new Error("ConditionalCheckFailedException: conditional request failed (already exists)");
        throw error;
    }
    return row;
}
