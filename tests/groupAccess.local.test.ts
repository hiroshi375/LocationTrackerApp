import { createLegacyLocationLog, createLegacyRecordingSession } from "../amplify/functions/share-group-api/legacyRecordingWrite";
import { indexedSessionLogPage, sessionLogKey } from "../amplify/functions/share-group-api/sessionLogIndex";
import { prepareStoppedHistoricalRecovery } from "../amplify/functions/share-group-api/historicalRecoveryAdmission";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    PutCommand,
    UpdateCommand,
    TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
    accessDb,
    tables,
    getRow,
    scanRows,
    withGroupLocks,
    groupFences,
    affectsGrant,
    requireGroupCoverage,
    historicalWriteGroups,
} from "../amplify/functions/share-group-api/groupAccessStore";
import {
    requestGroupAccessChange,
    getGroupJob,
    advanceGroupJob,
    advanceGroupJobBatch,
    resumeGroupJob,
    cancelGroupJob,
    reconcileGroupJobs,
    assertRecordOwner,
} from "../amplify/functions/share-group-api/groupAccessOperation";
import {
    ingestLocationLog,
    parseLocationInput,
} from "../amplify/functions/share-group-api/locationLogIngest";

// Deliberately hard-coded loopback endpoint and dummy credentials: never use AWS tables.
const raw = new DynamoDBClient({
    endpoint: "http://127.0.0.1:18000",
    region: "ap-northeast-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const local = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
});
accessDb.send = local.send.bind(local);
let sequence = 0;
async function setup(logCount = 3) {
    const prefix = `GroupAccessTest${Date.now()}${sequence++}`;
    for (const [env, key] of [
        ["GROUP_ACCESS_OPERATION_TABLE_NAME", "groupId"],
        ["SHARE_GROUP_TABLE_NAME", "groupId"],
        ["SHARE_GROUP_MEMBER_TABLE_NAME", "membershipId"],
        ["HISTORICAL_SHARE_GRANT_TABLE_NAME", "grantId"],
        ["HISTORICAL_RECORDING_SESSION_TABLE_NAME", "id"],
        ["HISTORICAL_LOCATION_LOG_TABLE_NAME", "id"],
        ["HISTORICAL_SHARE_OPERATION_TABLE_NAME", "recordingSessionRecordId"],
    ]) {
        const name = `${prefix}${env}`;
        process.env[env] = name;
        const composite = env === "GROUP_ACCESS_OPERATION_TABLE_NAME";
        await raw.send(
            new CreateTableCommand({
                TableName: name,
                BillingMode: "PAY_PER_REQUEST",
                KeySchema: [
                    { AttributeName: key, KeyType: "HASH" },
                    ...(composite
                        ? [
                              {
                                  AttributeName: "entryKey",
                                  KeyType: "RANGE" as const,
                              },
                          ]
                        : []),
                ],
                AttributeDefinitions: [
                    { AttributeName: key, AttributeType: "S" },
                    ...(composite
                        ? [
                              {
                                  AttributeName: "entryKey",
                                  AttributeType: "S" as const,
                              },
                          ]
                        : []),
                ],
            }),
        );
    }
    const put = async (table: string, row: object) => {
        await local.send(new PutCommand({ TableName: table, Item: row }));
    };
    for (const groupId of ["G", "H"]) {
        await put(tables.groups(), {
            groupId,
            ownerUserId: "A",
            name: groupId,
            isActive: true,
        });
        for (const userId of ["A", "B", "C"])
            await put(tables.members(), {
                membershipId: `${groupId}#${userId}`,
                groupId,
                userId,
                ownerValue: userId,
                role: userId === "A" ? "OWNER" : "MEMBER",
            });
    }
    const sid = "recording-session:A:s1";
    await put(tables.sessions(), {
        id: sid,
        userId: "A",
        owner: "A::a",
        recordingSessionId: "s1",
        sharedOwners: ["B", "C"],
    });
    await put(tables.operations(), {
        recordingSessionRecordId: sid,
        operationId: "previous",
        ownerUserId: "A",
        status: "COMPLETED",
        grantManaged: true,
    });
    for (let i = 0; i < logCount; i++)
        await put(tables.logs(), {
            id: `log${i}`,
            userId: "A",
            owner: "A::a",
            recordingSessionId: "s1",
            sharedOwners: ["B", "C"],
            latitude: 35,
            longitude: 139,
            recordedAt: "2026-10-16T00:00:00.000Z",
        });
    for (const [grantId, groupId, recipientUserId] of [
        ["GB", "G", "B"],
        ["GC", "G", "C"],
        ["HB", "H", "B"],
    ])
        await put(tables.grants(), {
            grantId,
            groupId,
            recipientUserId,
            recipientOwnerValue: recipientUserId,
            ownerUserId: "A",
            recordingSessionRecordId: sid,
            isActive: true,
            grantedAt: "2026-10-15T00:00:00.000Z",
        });
    return { put, sid };
}
async function finish(groupId: string, operationId: string, actor = "A") {
    for (let i = 0; i < 1000; i++) {
        const job = await getGroupJob(groupId, operationId, actor);
        if (job.status === "COMPLETED") return job;
        assert.equal(
            job.status,
            "READY",
            JSON.stringify({
                status: job.status,
                phase: job.phase,
                error: job.errorMessage,
            }),
        );
        await advanceGroupJob(groupId, operationId);
    }
    throw new Error("Job did not terminate");
}
async function until(groupId: string, operationId: string, phase: string) {
    for (let i = 0; i < 1000; i++) {
        const job = await getGroupJob(groupId, operationId, "A");
        if (job.phase === phase) return job;
        assert.equal(job.status, "READY", job.errorMessage);
        await advanceGroupJob(groupId, operationId);
    }
    throw new Error("Phase not reached");
}
test("authorization, request idempotency and cancellation before revocation", async () => {
    await setup();
    await assert.rejects(requestGroupAccessChange("B", "G", "DELETE"));
    await assert.rejects(requestGroupAccessChange("A", "G", "LEAVE"));
    await assert.rejects(requestGroupAccessChange("C", "G", "REMOVE", "B"));
    const first = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "request1",
    );
    const repeated = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "request1",
    );
    assert.equal(first.operationId, repeated.operationId);
    await assert.rejects(getGroupJob("G", first.operationId, "B"));
    await cancelGroupJob("G", first.operationId, "A");
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GB" }))?.isActive,
        true,
    );
    assert.equal(
        (await getRow(tables.members(), { membershipId: "G#B" }))?.userId,
        "B",
    );
});
test("group deletion across pages preserves a grant in another group and all log projections", async () => {
    await setup(81);
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "delete1",
    );
    await assert.rejects(withGroupLocks(["G"], async () => {}));
    await finish("G", op.operationId);
    assert.equal(
        (await getRow(tables.groups(), { groupId: "G" }))?.lifecycle,
        "DELETED",
    );
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GB" }))?.isActive,
        false,
    );
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GC" }))?.isActive,
        false,
    );
    assert.equal(
        (await getRow(tables.grants(), { grantId: "HB" }))?.isActive,
        true,
    );
    const logs = await scanRows(tables.logs(), () => true);
    assert.equal(logs.length, 81);
    for (const log of logs) assert.deepEqual(log.sharedOwners, ["B"]);
    assert.equal(
        (await scanRows(tables.members(), (r) => r.groupId === "G")).length,
        0,
    );
    const again = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "delete1",
    );
    assert.equal(again.status, "COMPLETED");
});
test("member departure revokes both received and owned grants, without disturbing other members", async () => {
    const { put } = await setup();
    const sid = "recording-session:B:s2";
    await put(tables.sessions(), {
        id: sid,
        userId: "B",
        owner: "B::b",
        recordingSessionId: "s2",
        sharedOwners: ["C"],
    });
    await put(tables.operations(), {
        recordingSessionRecordId: sid,
        operationId: "bprev",
        ownerUserId: "B",
        status: "COMPLETED",
        grantManaged: true,
    });
    await put(tables.logs(), {
        id: "bLog",
        userId: "B",
        owner: "B::b",
        recordingSessionId: "s2",
        sharedOwners: ["C"],
    });
    await put(tables.grants(), {
        grantId: "BC",
        groupId: "G",
        ownerUserId: "B",
        recipientUserId: "C",
        recipientOwnerValue: "C",
        recordingSessionRecordId: sid,
        isActive: true,
    });
    const op = await requestGroupAccessChange(
        "B",
        "G",
        "LEAVE",
        undefined,
        "leave1",
    );
    await finish("G", op.operationId, "B");
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GB" }))?.isActive,
        false,
    );
    assert.equal(
        (await getRow(tables.grants(), { grantId: "BC" }))?.isActive,
        false,
    );
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GC" }))?.isActive,
        true,
    );
    assert.deepEqual(
        (await getRow(tables.sessions(), { id: sid }))?.sharedOwners,
        [],
    );
    assert.equal(
        await getRow(tables.members(), { membershipId: "G#B" }),
        undefined,
    );
    assert.equal(
        (await getRow(tables.groups(), { groupId: "G" }))?.isActive,
        true,
    );
    assert.equal(
        (await requestGroupAccessChange("B", "G", "LEAVE", undefined, "leave1"))
            .status,
        "COMPLETED",
    );
});
test("deactivation preserves memberships but removes this group's grants", async () => {
    await setup();
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "DEACTIVATE",
        undefined,
        "disable1",
    );
    await finish("G", op.operationId);
    assert.equal(
        (await getRow(tables.groups(), { groupId: "G" }))?.lifecycle,
        "DISABLED",
    );
    assert.equal(
        (await scanRows(tables.members(), (row) => row.groupId === "G")).length,
        3,
    );
});
test("legacy sharing blocks deletion without losing memberships; cancellation is safe", async () => {
    const { sid } = await setup();
    await local.send(
        new UpdateCommand({
            TableName: tables.operations(),
            Key: { recordingSessionRecordId: sid },
            UpdateExpression: "SET grantManaged = :no",
            ExpressionAttributeValues: { ":no": false },
        }),
    );
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "legacy",
    );
    await advanceGroupJob("G", op.operationId);
    await advanceGroupJob("G", op.operationId);
    const job = await getGroupJob("G", op.operationId, "A");
    assert.equal(job.status, "FAILED");
    assert.match(job.errorMessage, /NEEDS_MIGRATION/);
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GB" }))?.isActive,
        true,
    );
    assert.equal(
        (await scanRows(tables.members(), (row) => row.groupId === "G")).length,
        3,
    );
    await cancelGroupJob("G", op.operationId, "A");
});
test("resume after grant revocation completes projection instead of losing inactive-grant work", async () => {
    const { sid } = await setup(55);
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "resume",
    );
    const job = await until("G", op.operationId, "LOGS");
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GB" }))?.isActive,
        false,
    );
    await assert.rejects(
        ingestLocationLog("A", "a", {
            id: "late",
            userId: "A",
            recordingSessionId: "s1",
            latitude: 35,
            longitude: 139,
            recordedAt: "2026-10-16T00:00:00.000Z",
            sharedOwners: ["C"],
        }),
    );
    await local.send(
        new UpdateCommand({
            TableName: tables.jobs(),
            Key: { groupId: "G", entryKey: `OP#${op.operationId}` },
            UpdateExpression:
                "SET #s = :running, runToken = :old, lockedUntil = :until",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
                ":running": "RUNNING",
                ":old": "expired",
                ":until": Date.now() - 1,
            },
        }),
    );
    await reconcileGroupJobs();
    await finish("G", op.operationId);
    assert.deepEqual(
        (await getRow(tables.sessions(), { id: sid }))?.sharedOwners,
        ["B"],
    );
    assert.equal(
        job.sessionOperationId,
        (await getRow(tables.operations(), { recordingSessionRecordId: sid }))
            ?.operationId,
    );
});
test("late queued sharedOwners cannot restore revoked access, with ownership and duplicate checks", async () => {
    await setup();
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "late",
    );
    await finish("G", op.operationId);
    const input = {
        id: "lateLog",
        userId: "A",
        recordingSessionId: "s1",
        latitude: 35,
        longitude: 139,
        recordedAt: "2026-10-16T00:00:00.000Z",
        sharedOwners: ["C"],
        owner: "attacker",
    };
    assert.equal((await ingestLocationLog("A", "a", input)).created, true);
    const saved = await getRow(tables.logs(), { id: "lateLog" });
    assert.deepEqual(saved?.sharedOwners, ["B"]);
    assert.equal(saved?.owner, "A::a");
    assert.equal((await ingestLocationLog("A", "a", input)).created, false);
    await assert.rejects(ingestLocationLog("B", "b", input));
    assert.throws(() => parseLocationInput({ ...input, latitude: 100 }, "A"));
});
test("released group capability cannot commit a late mutation", async () => {
    await setup();
    assert.deepEqual(await historicalWriteGroups("A", "G", "s1"), ["G"]);
    assert.throws(() => assertRecordOwner({ userId: "A", owner: "B::b" }, "A"));
    let fences = groupFences();
    await withGroupLocks(["G"], async () => {
        fences = groupFences();
        assert.throws(() => requireGroupCoverage(["H"]));
    });
    await assert.rejects(
        local.send(
            new TransactWriteCommand({
                TransactItems: [
                    ...fences,
                    {
                        Put: {
                            TableName: tables.grants(),
                            Item: { grantId: "stale" },
                        },
                    },
                ],
            }),
        ),
    );
    assert.equal(
        await getRow(tables.grants(), { grantId: "stale" }),
        undefined,
    );
    assert.equal(
        affectsGrant("REMOVE", "B", { ownerUserId: "B", recipientUserId: "C" }),
        true,
    );
    assert.equal(
        affectsGrant("REMOVE", "B", { ownerUserId: "A", recipientUserId: "C" }),
        false,
    );
});
test("owner removal preserves the owner record and prevents automatic grant revival on rejoin", async () => {
    const { put, sid } = await setup();
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "REMOVE",
        "B",
        "remove1",
    );
    await finish("G", op.operationId);
    assert.equal((await getRow(tables.sessions(), { id: sid }))?.owner, "A::a");
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GC" }))?.isActive,
        true,
    );
    await withGroupLocks(["G"], async () => {
        await put(tables.members(), {
            membershipId: "G#B",
            groupId: "G",
            userId: "B",
            ownerValue: "B",
            role: "MEMBER",
        });
    });
    assert.equal(
        (await getRow(tables.grants(), { grantId: "GB" }))?.isActive,
        false,
    );
});
test("expired normal lock is fenced before a group operation can start", async () => {
    await setup();
    await local.send(
        new PutCommand({
            TableName: tables.jobs(),
            Item: {
                groupId: "G",
                entryKey: "GATE",
                lockToken: "old",
                lockStartedAt: new Date(Date.now() - 120000).toISOString(),
            },
        }),
    );
    await assert.rejects(
        requestGroupAccessChange("A", "G", "DELETE", undefined, "before"),
    );
    await reconcileGroupJobs();
    assert.equal(
        (await getRow(tables.jobs(), { groupId: "G", entryKey: "GATE" }))
            ?.lockToken,
        undefined,
    );
    await assert.rejects(
        local.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        ConditionCheck: {
                            TableName: tables.jobs(),
                            Key: { groupId: "G", entryKey: "GATE" },
                            ConditionExpression: "lockToken = :old",
                            ExpressionAttributeValues: { ":old": "old" },
                        },
                    },
                    {
                        Put: {
                            TableName: tables.grants(),
                            Item: { grantId: "lateOldMutation" },
                        },
                    },
                ],
            }),
        ),
    );
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "after",
    );
    await finish("G", op.operationId);
});
test("expired job invocation cannot write using its old runToken after resume", async () => {
    await setup();
    const op = await requestGroupAccessChange(
        "A",
        "G",
        "DELETE",
        undefined,
        "fence-job",
    );
    const key = { groupId: "G", entryKey: `OP#${op.operationId}` };
    await local.send(
        new UpdateCommand({
            TableName: tables.jobs(),
            Key: key,
            UpdateExpression:
                "SET #s = :running, runToken = :old, lockedUntil = :until",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
                ":running": "RUNNING",
                ":old": "oldJobToken",
                ":until": Date.now() - 1,
            },
        }),
    );
    await resumeGroupJob("G", op.operationId, "A");
    await assert.rejects(
        local.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        ConditionCheck: {
                            TableName: tables.jobs(),
                            Key: key,
                            ConditionExpression: "runToken = :old",
                            ExpressionAttributeValues: {
                                ":old": "oldJobToken",
                            },
                        },
                    },
                    {
                        Put: {
                            TableName: tables.grants(),
                            Item: { grantId: "lateJobMutation" },
                        },
                    },
                ],
            }),
        ),
    );
    assert.equal(
        await getRow(tables.grants(), { grantId: "lateJobMutation" }),
        undefined,
    );
    await finish("G", op.operationId);
});

test("expired historical recovery admission is fenced and CAS rejects stale snapshots", async () => {
    const { put, sid } = await setup();
    const previous: any = { recordingSessionRecordId: sid, operationId: "stopped", ownerUserId: "A", status: "APPLYING", grantManaged: true,
        groupId: "G", recipientUserId: "B", requestedEnabled: true, operationPhase: "GRANT_WRITE_CONFIRMED",
        grantWriteConfirmedAt: new Date(Date.now() - 120000).toISOString(), updatedAt: new Date(Date.now() - 120000).toISOString() };
    await put(tables.operations(), previous);
    const args = { groupId: "G", recipientUserId: "B", enabled: true };
    await withGroupLocks(["G"], () => prepareStoppedHistoricalRecovery(previous, "A", args));
    assert.equal((await getRow(tables.operations(), { recordingSessionRecordId: sid }))?.status, "FAILED");
    await assert.rejects(withGroupLocks(["G"], () => prepareStoppedHistoricalRecovery(previous, "A", args)));
    // A stale group capability must not be able to admit recovery, even if
    // the session snapshot itself is unchanged.
    await put(tables.operations(), previous);
    await withGroupLocks(["G"], async () => {
        await local.send(new UpdateCommand({ TableName: tables.jobs(), Key: { groupId: "G", entryKey: "GATE" },
            UpdateExpression: "SET lockToken = :new", ExpressionAttributeValues: { ":new": "replacement" } }));
        await assert.rejects(prepareStoppedHistoricalRecovery(previous, "A", args));
    });
    assert.equal((await getRow(tables.operations(), { recordingSessionRecordId: sid }))?.status, "APPLYING");
});

test("indexed revocation never scans LocationLog and preserves other-group grants", async () => {
    const { put, sid } = await setup(160);
    const indexName = `SessionIndex${Date.now()}`;
    await raw.send(new CreateTableCommand({ TableName: indexName, BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "sessionKey", KeyType: "HASH" }, { AttributeName: "logId", KeyType: "RANGE" }],
        AttributeDefinitions: [{ AttributeName: "sessionKey", AttributeType: "S" }, { AttributeName: "logId", AttributeType: "S" }],
    }));
    process.env.SESSION_LOG_INDEX_TABLE_NAME = indexName;
    for (let i = 0; i < 160; i++) await put(indexName, { sessionKey: sessionLogKey("A", "s1"), logId: `log${i}` });
    await put(indexName, { sessionKey: sessionLogKey("A", "s1"), logId: "deleted-log" });
    await put(indexName, { sessionKey: "__CONTROL__", logId: "READY", version: 1, legacySharingVerified: true });
    const original = accessDb.send;
    let scans = 0;
    accessDb.send = (async (command: any) => {
        if (command.constructor.name === "ScanCommand" && command.input.TableName === tables.logs()) {
            scans++; throw new Error("Forbidden global LocationLog scan");
        }
        return local.send(command);
    }) as typeof accessDb.send;
    try {
        const job = await requestGroupAccessChange("A", "G", "DELETE", undefined, "indexed-delete");
        await advanceGroupJobBatch("G", job.operationId);
        await finish("G", job.operationId);
        assert.equal(scans, 0);
        assert.deepEqual((await getRow(tables.sessions(), { id: sid }))?.sharedOwners, ["B"]);
        for (let i = 0; i < 160; i++) assert.deepEqual((await getRow(tables.logs(), { id: `log${i}` }))?.sharedOwners, ["B"]);
        assert.equal((await getRow(tables.grants(), { grantId: "HB" }))?.isActive, true);
        // A late upload must atomically enter the inventory and inherit the remaining grant.
        await ingestLocationLog("A", "a", { id: "new-indexed", userId: "A", latitude: 35, longitude: 139,
            recordedAt: "2026-10-17T00:00:00.000Z", recordingSessionId: "s1" });
        assert.ok(await getRow(indexName, { sessionKey: sessionLogKey("A", "s1"), logId: "new-indexed" }));
        assert.deepEqual((await getRow(tables.logs(), { id: "new-indexed" }))?.sharedOwners, ["B"]);
    } finally { accessDb.send = original; delete process.env.SESSION_LOG_INDEX_TABLE_NAME; }
});

test("indexed reads reject cross-owner entries rather than changing another user's logs", async () => {
    await setup();
    const name = `BadIndex${Date.now()}`;
    await raw.send(new CreateTableCommand({ TableName: name, BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "sessionKey", KeyType: "HASH" }, { AttributeName: "logId", KeyType: "RANGE" }],
        AttributeDefinitions: [{ AttributeName: "sessionKey", AttributeType: "S" }, { AttributeName: "logId", AttributeType: "S" }],
    }));
    process.env.SESSION_LOG_INDEX_TABLE_NAME = name;
    await local.send(new PutCommand({ TableName: name, Item: { sessionKey: sessionLogKey("other", "s1"), logId: "log0" } }));
    try { await assert.rejects(indexedSessionLogPage("other", "s1"), /NEEDS_REPAIR/); }
    finally { delete process.env.SESSION_LOG_INDEX_TABLE_NAME; }
});


test("released create mutations remain compatible while server controls sharing", async () => {
    await setup();
    const log = await createLegacyLocationLog("A", "a", { id: "released-log", userId: "A",
        recordingSessionId: "s1", latitude: 35, longitude: 139,
        recordedAt: "2026-10-17T01:00:00.000Z", sharedOwners: ["ATTACKER"], owner: "ATTACKER" });
    assert.equal(log?.userId, "A");
    assert.equal(log?.owner, "A::a");
    assert.deepEqual(log?.sharedOwners, ["B", "C"]);
    await assert.rejects(createLegacyLocationLog("A", "a", { id: "foreign", userId: "B", latitude: 35,
        longitude: 139, recordedAt: "2026-10-17T01:00:00.000Z" }));
    const session = await createLegacyRecordingSession("A", "a", { id: "released-session", userId: "A",
        recordingSessionId: "new-session", sharedOwners: ["ATTACKER"], owner: "ATTACKER" });
    assert.deepEqual(session.sharedOwners, []);
    assert.equal(session.owner, "A::a");
    await assert.rejects(createLegacyRecordingSession("A", "a", { id: "foreign-session", userId: "B" }));
    await assert.rejects(createLegacyRecordingSession("A", "a", { id: "released-session", userId: "A" }));
});
