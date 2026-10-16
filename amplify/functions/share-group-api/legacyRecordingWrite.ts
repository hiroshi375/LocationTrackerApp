import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ingestLocationLog } from "./locationLogIngest";
import { accessDb, getRow, tables, type Row } from "./groupAccessStore";

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
    const timestamp = new Date().toISOString();
    const row = { ...input, id, owner: username ? `${userId}::${username}` : userId,
        sharedOwners: [], createdAt: timestamp, updatedAt: timestamp, __typename: "RecordingSession" };
    await accessDb.send(new PutCommand({ TableName: tables.sessions(), Item: row,
        ConditionExpression: "attribute_not_exists(id)" }));
    return row;
}
