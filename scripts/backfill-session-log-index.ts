/** One-time, explicitly invoked admin backfill. Deploy dual writes + immutable keys first. */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
const names = {
    logs: process.env.HISTORICAL_LOCATION_LOG_TABLE_NAME!,
    sessions: process.env.HISTORICAL_RECORDING_SESSION_TABLE_NAME!,
    operations: process.env.HISTORICAL_SHARE_OPERATION_TABLE_NAME!,
    index: process.env.SESSION_LOG_INDEX_TABLE_NAME!,
};
if (Object.values(names).some(x => !x) || !process.argv.includes("--apply"))
    throw new Error("Explicit table environment and --apply required. Deploy the indexed ingest/immutable identity first.");
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
async function scan(table: string, projection: string) {
    const rows: Record<string, any>[] = []; let cursor;
    do {
        const p: any = await db.send(new ScanCommand({ TableName: table, ConsistentRead: true,
            ProjectionExpression: projection, ExclusiveStartKey: cursor }));
        rows.push(...(p.Items ?? [])); cursor = p.LastEvaluatedKey;
    } while (cursor);
    return rows;
}
async function main() {
    const old = await db.send(new GetCommand({ TableName: names.index,
        Key: { sessionKey: "__CONTROL__", logId: "READY" }, ConsistentRead: true }));
    if (old.Item) throw new Error("Index already published; do not rebuild a live index using this initial migration.");
    const [sessions, operations, logs] = await Promise.all([
        scan(names.sessions, "id,userId,recordingSessionId,sharedOwners"),
        scan(names.operations, "recordingSessionRecordId,grantManaged"),
        scan(names.logs, "id,userId,recordingSessionId,sharedOwners"),
    ]);
    const managed = new Set(operations.filter(x => x.grantManaged === true).map(x => x.recordingSessionRecordId));
    const sessionMap = new Map<string, any>();
    const key = (u: string, s: string) => JSON.stringify([u, s]);
    for (const s of sessions) {
        const k = key(s.userId, s.recordingSessionId);
        if (sessionMap.has(k)) throw new Error("Duplicate owner/session identity; repair before activation.");
        sessionMap.set(k, s);
        if (s.sharedOwners?.length && !managed.has(s.id)) throw new Error("Unmanaged shared session remains.");
    }
    for (const l of logs) {
        if (!l.id || !l.userId) throw new Error("Malformed log identity.");
        if (l.sharedOwners?.length && !managed.has(sessionMap.get(key(l.userId, l.recordingSessionId))?.id))
            throw new Error("Unmanaged shared log remains.");
    }
    const indexed = logs.filter(l => l.recordingSessionId);
    const chunks: any[][] = [];
    for (let i = 0; i < indexed.length; i += 25) chunks.push(indexed.slice(i, i + 25).map(l => ({ PutRequest: { Item: {
        sessionKey: key(l.userId, l.recordingSessionId), logId: l.id,
    } } })));
    let offset = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
        while (offset < chunks.length) {
            let pending = chunks[offset++];
            for (let attempt = 0; pending.length && attempt < 10; attempt++) {
                const p = await db.send(new BatchWriteCommand({ RequestItems: { [names.index]: pending } }));
                pending = p.UnprocessedItems?.[names.index] ?? [];
                if (pending.length) await new Promise(r => setTimeout(r, 50 * 2 ** attempt));
            }
            if (pending.length) throw new Error("Backfill incomplete; READY was not published.");
        }
    }));
    // Compare every source identity to the strongly consistent base-table index.
    const entries = await scan(names.index, "sessionKey,logId");
    const present = new Set(entries.map(e => JSON.stringify([e.sessionKey, e.logId])));
    if (indexed.some(l => !present.has(JSON.stringify([key(l.userId, l.recordingSessionId), l.id]))))
        throw new Error("Index completeness verification failed; READY was not published.");
    await db.send(new PutCommand({ TableName: names.index, Item: {
        sessionKey: "__CONTROL__", logId: "READY", version: 1, legacySharingVerified: true,
        verifiedAt: new Date().toISOString(), backfilledCount: indexed.length,
    }, ConditionExpression: "attribute_not_exists(sessionKey)" }));
    console.log(JSON.stringify({ ready: true, backfilledCount: indexed.length, verifiedCount: present.size }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
