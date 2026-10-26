import { randomUUID } from "node:crypto";
import { QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { accessDb, getRow, scanRows, tables, type Row } from "./groupAccessStore";
import { assertRecordOwner } from "./recordOwnership";
import { indexTable, sessionIndexReady, sessionLogKey } from "./sessionLogIndex";
import { assertAccountNotDeleting } from "./accountDeletionGuard";

type Writes = NonNullable<TransactWriteCommandInput["TransactItems"]>;
const discarded = "DISCARDED";
const discarding = "DISCARDING";

// A permanent operation tombstone blocks both old/new ingest transactions and
// session recreation. Process one bounded chunk per call so retries remain safe.
export async function discardRecordingSessionBatch(userId: string, sessionId: string): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
        try { return await discardOnce(userId, sessionId); }
        catch (error: any) {
            const reasons = error.CancellationReasons;
            const retryable = error.name === "TransactionCanceledException" && Array.isArray(reasons) &&
                reasons.some((reason: any) => ["ConditionalCheckFailed", "TransactionConflict"].includes(reason.Code)) &&
                reasons.every((reason: any) => ["None", "ConditionalCheckFailed", "TransactionConflict"].includes(reason.Code));
            if (!retryable || attempt >= 3) throw error;
            // Re-read ownership and the checkpoint, never replay stale delete writes.
            await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt + Math.floor(Math.random() * 25)));
        }
    }
}

async function discardOnce(userId: string, sessionId: string): Promise<boolean> {
    await assertAccountNotDeleting(userId);
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 1024)
        throw new Error("破棄するセッションIDが不正です。");
    if (!await sessionIndexReady()) throw new Error("セッション索引の準備が完了していません。");
    const canonicalId = `recording-session:${userId}:${sessionId}`;
    let session = await getRow(tables.sessions(), { id: canonicalId });
    if (!session) {
        const matches = await scanRows(tables.sessions(), row => row.userId === userId && row.recordingSessionId === sessionId);
        if (matches.length > 1) throw new Error("セッションが重複しています。破棄を中止しました。");
        session = matches[0];
    }
    if (session) {
        assertRecordOwner(session, userId);
        if (session.recordingSessionId !== sessionId) throw new Error("セッションIDが一致しません。");
    }
    const ids = [...new Set([canonicalId, session?.id].filter(Boolean))] as string[];
    const previous = await Promise.all(ids.map(id => getRow(tables.operations(), { recordingSessionRecordId: id })));
    for (const operation of previous) {
        if (operation?.discardOperation === true) {
            if (operation.ownerUserId !== userId || operation.recordingSessionId !== sessionId)
                throw new Error("破棄処理の所有者が一致しません。");
        } else if (operation && operation.status !== "COMPLETED") {
            throw new Error("共有処理中のため破棄できません。処理完了後に再試行してください。");
        }
    }
    if (previous.every(operation => operation?.discardOperation === true && operation.status === discarded)) return true;
    const operationId = previous.find(operation => operation?.discardOperation === true)?.operationId ?? randomUUID();
    if (previous.some(operation => operation?.discardOperation === true && operation.operationId !== operationId))
        throw new Error("破棄処理の世代が一致しません。");
    const timestamp = new Date().toISOString();
    const admission: Writes = [];
    ids.forEach((id, i) => {
        const old = previous[i];
        if (old?.discardOperation === true) return;
        admission.push({ Put: {
            TableName: tables.operations(),
            Item: { recordingSessionRecordId: id, recordingSessionId: sessionId, ownerUserId: userId,
                operationId, status: discarding, discardOperation: true, updatedAt: timestamp },
            ConditionExpression: old ? "operationId = :id AND #status = :completed" : "attribute_not_exists(recordingSessionRecordId)",
            ...(old ? { ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":id": old.operationId, ":completed": "COMPLETED" } } : {}),
        } });
    });
    if (admission.length) await accessDb.send(new TransactWriteCommand({ TransactItems: admission }));
    const fence = (): Writes => ids.map(id => ({ ConditionCheck: {
        TableName: tables.operations(), Key: { recordingSessionRecordId: id },
        ConditionExpression: "operationId = :id AND #status = :discarding",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":id": operationId, ":discarding": discarding },
    } }));
    const indexName = indexTable()!;
    const page = await accessDb.send(new QueryCommand({ TableName: indexName,
        KeyConditionExpression: "sessionKey = :key", ExpressionAttributeValues: { ":key": sessionLogKey(userId, sessionId) },
        ConsistentRead: true, Limit: 20 }));
    if (page.Items?.length) {
        const rows = await Promise.all(page.Items.map(item => getRow(tables.logs(), { id: item.logId })));
        const writes = fence();
        page.Items.forEach((item, i) => {
            const row = rows[i];
            if (row) {
                assertRecordOwner(row, userId);
                if (row.recordingSessionId !== sessionId) throw new Error("索引とセッションが一致しません。");
                writes.push({ Delete: { TableName: tables.logs(), Key: { id: row.id },
                    ConditionExpression: "#owner = :owner AND userId = :userId AND recordingSessionId = :session",
                    ExpressionAttributeNames: { "#owner": "owner" },
                    ExpressionAttributeValues: { ":owner": row.owner, ":userId": userId, ":session": sessionId } } });
            }
            writes.push({ Delete: { TableName: indexName, Key: { sessionKey: item.sessionKey, logId: item.logId } } });
        });
        await accessDb.send(new TransactWriteCommand({ TransactItems: writes }));
        return false;
    }
    const grants = (await scanRows(tables.grants(), row => ids.includes(row.recordingSessionRecordId))).slice(0, 20);
    if (grants.length) {
        const writes = fence();
        for (const grant of grants) {
            if (grant.ownerUserId !== userId) throw new Error("共有権限の所有者が一致しません。");
            writes.push({ Delete: { TableName: tables.grants(), Key: { grantId: grant.grantId },
                ConditionExpression: "ownerUserId = :userId AND recordingSessionRecordId = :session",
                ExpressionAttributeValues: { ":userId": userId, ":session": grant.recordingSessionRecordId } } });
        }
        await accessDb.send(new TransactWriteCommand({ TransactItems: writes }));
        return false;
    }
    const finish: Writes = ids.map(id => ({ Update: { TableName: tables.operations(), Key: { recordingSessionRecordId: id },
        UpdateExpression: "SET #status = :done, updatedAt = :now",
        ConditionExpression: "operationId = :id AND #status = :discarding",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":id": operationId, ":discarding": discarding, ":done": discarded, ":now": timestamp } } }));
    if (session) finish.push({ Delete: { TableName: tables.sessions(), Key: { id: session.id },
        ConditionExpression: "#owner = :owner AND userId = :userId AND recordingSessionId = :session",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": session.owner, ":userId": userId, ":session": sessionId } } });
    await accessDb.send(new TransactWriteCommand({ TransactItems: finish }));
    return true;
}
