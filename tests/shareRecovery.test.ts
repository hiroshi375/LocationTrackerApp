import assert from "node:assert/strict";
import { test } from "node:test";
import { fencedWrite, accessDb } from "../amplify/functions/share-group-api/groupAccessStore";
import { readSessionLogs, withSessionLogInventory } from "../amplify/functions/share-group-api/sessionLogReader";
import { prepareStoppedHistoricalRecovery } from "../amplify/functions/share-group-api/historicalRecoveryAdmission";

process.env.HISTORICAL_LOCATION_LOG_TABLE_NAME = "local-only-logs";
process.env.HISTORICAL_SHARE_OPERATION_TABLE_NAME = "local-only-operations";
test("session inventory paginates once and rereads only its IDs with current values", async () => {
    let scans = 0, batches = 0;
    let owners = ["B"];
    accessDb.send = (async (command: any) => {
        if (command.constructor.name === "ScanCommand") {
            scans++;
            assert.equal(command.input.Limit, undefined);
            assert.equal(command.input.ConsistentRead, true);
            assert.equal(command.input.ExpressionAttributeValues[":u"], "A");
            assert.ok(command.input.FilterExpression);
            return { Items: [{ id: `log${scans}`, userId: "A", recordingSessionId: "s", sharedOwners: owners }],
                ...(scans === 1 ? { LastEvaluatedKey: { id: "log1" } } : {}) };
        }
        assert.equal(command.constructor.name, "BatchGetCommand");
        batches++;
        const request = command.input.RequestItems["local-only-logs"];
        assert.equal(request.ConsistentRead, true);
        return { Responses: { "local-only-logs": request.Keys.map((key: any) => ({ ...key, userId: "A", recordingSessionId: "s", sharedOwners: owners })) } };
    }) as any;
    await withSessionLogInventory(async () => {
        assert.equal((await readSessionLogs("A", "s")).length, 2);
        owners = [];
        assert.deepEqual((await readSessionLogs("A", "s"))[0].sharedOwners, []);
        await readSessionLogs("A", "s");
    });
    assert.equal(scans, 2); assert.equal(batches, 2);
});
test("missing target cannot pass verification", async () => {
    let scans = 0;
    accessDb.send = (async (command: any) => {
        if (command.constructor.name === "ScanCommand") { scans++; return { Items: [{ id: "l", userId: "A", recordingSessionId: "s" }] }; }
        return { Responses: { "local-only-logs": [] } };
    }) as any;
    await withSessionLogInventory(async () => {
        await readSessionLogs("A", "s");
        await assert.rejects(readSessionLogs("A", "s"), /変更/);
    });
    assert.equal(scans, 1);
});
test("recovery rejects live, unconfirmed, foreign, and different intents before writing", async () => {
    let writes = 0;
    accessDb.send = (async () => { writes++; return {}; }) as any;
    const previous: any = { recordingSessionRecordId: "s", operationId: "old", ownerUserId: "A", groupId: "g", recipientUserId: "B", requestedEnabled: true,
        grantManaged: true, operationPhase: "GRANT_WRITE_CONFIRMED", grantWriteConfirmedAt: new Date().toISOString(), status: "APPLYING", updatedAt: new Date(Date.now() - 120000).toISOString() };
    const args = { groupId: "g", recipientUserId: "B", enabled: true };
    await assert.rejects(prepareStoppedHistoricalRecovery({ ...previous, updatedAt: new Date().toISOString() }, "A", args), /90秒/);
    await assert.rejects(prepareStoppedHistoricalRecovery(previous, "C", args));
    await assert.rejects(prepareStoppedHistoricalRecovery(previous, "A", { ...args, enabled: false }));
    await assert.rejects(prepareStoppedHistoricalRecovery({ ...previous, operationPhase: "INTENT_RECORDED" }, "A", args));
    await assert.rejects(prepareStoppedHistoricalRecovery({ ...previous, updatedAt: "invalid" }, "A", args));
    assert.equal(writes, 0);
    await prepareStoppedHistoricalRecovery(previous, "A", args);
    assert.equal(writes, 1);
});

test("only pure transaction conflicts retry; conditions and unknown outcomes stop", async () => {
    let calls = 0;
    const conflict = Object.assign(new Error("conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] });
    accessDb.send = (async () => { calls++; if (calls === 1) throw conflict; return {}; }) as any;
    await fencedWrite([]);
    assert.equal(calls, 2);
    for (const failure of [
        Object.assign(new Error("condition"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "ConditionalCheckFailed" }] }),
        new Error("network outcome unknown"),
    ]) {
        calls = 0;
        accessDb.send = (async () => { calls++; throw failure; }) as any;
        await assert.rejects(fencedWrite([]));
        assert.equal(calls, 1);
    }
});
