import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { accessDb, getRow, tables, type Row } from "./groupAccessStore";

export const sessionLogKey = (userId: string, sessionId: string) =>
    JSON.stringify([userId, sessionId]);
export const indexTable = () => process.env.SESSION_LOG_INDEX_TABLE_NAME;
export async function sessionIndexReady() {
    const table = indexTable();
    if (!table) return false;
    const state = await getRow(table, { sessionKey: "__CONTROL__", logId: "READY" });
    return state?.version === 1 && state?.legacySharingVerified === true;
}
export function logIndexWrite(log: Row) {
    const table = indexTable();
    if (!table || !log.recordingSessionId) return undefined;
    return { Put: { TableName: table, Item: {
        sessionKey: sessionLogKey(log.userId, log.recordingSessionId),
        logId: log.id,
    } } };
}
export async function indexedSessionLogPage(userId: string, sessionId: string, cursor?: Row) {
    const table = indexTable();
    if (!table) throw new Error("セッションログ索引が設定されていません。");
    const page = await accessDb.send(new QueryCommand({
        TableName: table, KeyConditionExpression: "sessionKey = :key",
        ExpressionAttributeValues: { ":key": sessionLogKey(userId, sessionId) },
        ConsistentRead: true, ExclusiveStartKey: cursor, Limit: 75,
    }));
    const keys = (page.Items ?? []).map(row => ({ id: row.logId }));
    const rows: Row[] = [];
    let pending = keys;
    for (let attempt = 0; pending.length && attempt < 6; attempt++) {
        const result = await accessDb.send(new BatchGetCommand({ RequestItems: {
            [tables.logs()]: { Keys: pending, ConsistentRead: true },
        } }));
        rows.push(...(result.Responses?.[tables.logs()] ?? []));
        pending = (result.UnprocessedKeys?.[tables.logs()]?.Keys ?? []).map(row => ({ id: row.id }));
        if (pending.length) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
    if (pending.length) throw new Error("セッションログの強整合取得が完了しませんでした。");
    // Owner deletions may leave harmless index tombstones. Reassigned IDs must fail closed.
    if (rows.some(row => row.userId !== userId || row.recordingSessionId !== sessionId))
        throw new Error("NEEDS_REPAIR: セッション索引とログの所有者が一致しません。");
    return { Items: rows, LastEvaluatedKey: page.LastEvaluatedKey };
}
