import { AsyncLocalStorage } from "node:async_hooks";
import { BatchGetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { accessDb, tables, type Row } from "./groupAccessStore";
import { indexedSessionLogPage, sessionIndexReady } from "./sessionLogIndex";

// Scope IDs to one admitted write. Ingest rejects writes while its session
// operation is non-COMPLETED; never reuse this inventory across invocations.
const inventories = new AsyncLocalStorage<Map<string, string[]>>();
export function withSessionLogInventory<T>(run: () => Promise<T>): Promise<T> {
    return inventories.run(new Map(), run);
}
export function resetSessionLogInventory() { inventories.getStore()?.clear(); }
export async function readSessionLogs(ownerUserId: string, sessionId: string): Promise<Row[]> {
    const key = JSON.stringify([ownerUserId, sessionId]);
    const inventory = inventories.getStore();
    const ids = inventory?.get(key);
    const table = tables.logs();
    if (!ids && await sessionIndexReady()) {
        const rows: Row[] = [];
        let cursor: Row | undefined;
        do {
            const page = await indexedSessionLogPage(ownerUserId, sessionId, cursor);
            rows.push(...page.Items);
            cursor = page.LastEvaluatedKey;
        } while (cursor);
        inventory?.set(key, rows.map(row => row.id));
        return rows;
    }
    if (!ids) {
        const rows: Row[] = [];
        let cursor: Row | undefined;
        do {
            // No 50-item limit: consume DynamoDB's 1 MB pages, filter on server.
            // A GSI alone cannot prove completeness immediately after ingest.
            const page = await accessDb.send(new ScanCommand({
                TableName: table, ConsistentRead: true, ExclusiveStartKey: cursor,
                FilterExpression: "#u = :u AND #s = :s",
                ProjectionExpression: "id, #u, #s, #o, sharedOwners",
                ExpressionAttributeNames: { "#u": "userId", "#s": "recordingSessionId", "#o": "owner" },
                ExpressionAttributeValues: { ":u": ownerUserId, ":s": sessionId },
            }));
            rows.push(...(page.Items ?? []));
            cursor = page.LastEvaluatedKey;
        } while (cursor);
        inventory?.set(key, rows.map(row => row.id));
        return rows;
    }
    const rows: Row[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
        let pending = ids.slice(offset, offset + 100).map(id => ({ id }));
        for (let attempt = 0; pending.length && attempt < 6; attempt++) {
            const page = await accessDb.send(new BatchGetCommand({ RequestItems: {
                [table]: { Keys: pending, ConsistentRead: true },
            } }));
            rows.push(...(page.Responses?.[table] ?? []));
            pending = (page.UnprocessedKeys?.[table]?.Keys ?? []).map(row => ({ id: row.id as string }));
            if (pending.length) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
        }
        if (pending.length) throw new Error("対象ログの強整合読み取りが完了しませんでした。");
    }
    if (rows.length !== ids.length || rows.some(row => row.userId !== ownerUserId || row.recordingSessionId !== sessionId)) {
        throw new Error("共有操作中に対象ログが変更されました。再取得が必要です。");
    }
    return rows;
}
