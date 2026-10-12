const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const {
    DynamoDBDocumentClient,
    ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

const fs = require("node:fs");

const region = process.env.AWS_REGION || "ap-northeast-1";

const tables = {
    grant: process.env.GRANT_TABLE,
    operation: process.env.OPERATION_TABLE,
    session: process.env.SESSION_TABLE,
    log: process.env.LOG_TABLE,
};

const sessionIds = new Set(
    [
        process.env.SESSION_A,
        process.env.SESSION_B,
        process.env.SESSION_C,
    ].filter(Boolean),
);

if (Object.values(tables).some((name) => !name)) {
    throw new Error("テーブル名が設定されていません。");
}

if (sessionIds.size !== 3) {
    throw new Error("3つのセッションIDを設定してください。");
}

const mode = process.argv[2];

if (!["before", "after"].includes(mode)) {
    throw new Error("before または after を指定してください。");
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

async function scanAll(tableName, projection) {
    let nextKey;
    const items = [];

    do {
        const result = await db.send(
            new ScanCommand({
                TableName: tableName,
                ConsistentRead: true,
                ...projection,
                ExclusiveStartKey: nextKey,
            }),
        );

        items.push(...(result.Items || []));
        nextKey = result.LastEvaluatedKey;
    } while (nextKey);

    return items;
}

function normalizeOwners(value) {
    return Array.isArray(value) ? [...value].sort() : (value ?? null);
}

async function main() {
    const sessions = await scanAll(tables.session, {
        ProjectionExpression: "#id, recordingSessionId, sharedOwners",
        ExpressionAttributeNames: {
            "#id": "id",
        },
    });

    const targets = sessions.filter((item) =>
        sessionIds.has(item.recordingSessionId),
    );

    if (targets.length !== 3) {
        throw new Error(`対象セッションが3件ではありません: ${targets.length}`);
    }

    const recordIds = new Set(targets.map((item) => item.id));

    const grants = await scanAll(tables.grant, {
        ProjectionExpression:
            "grantId, recordingSessionRecordId, " +
            "isActive, grantedAt, revokedAt",
    });

    const operations = await scanAll(tables.operation, {
        ProjectionExpression: "recordingSessionRecordId, #status, grantManaged",
        ExpressionAttributeNames: {
            "#status": "status",
        },
    });

    const logs = await scanAll(tables.log, {
        ProjectionExpression: "#id, recordingSessionId, sharedOwners",
        ExpressionAttributeNames: {
            "#id": "id",
        },
    });

    const snapshot = {
        sessions: targets.map((item) => ({
            id: item.id,
            recordingSessionId: item.recordingSessionId,
            sharedOwners: normalizeOwners(item.sharedOwners),
        })),
        grants: grants.filter((item) =>
            recordIds.has(item.recordingSessionRecordId),
        ),
        operations: operations.filter((item) =>
            recordIds.has(item.recordingSessionRecordId),
        ),
        logs: logs
            .filter((item) => sessionIds.has(item.recordingSessionId))
            .map((item) => ({
                id: item.id,
                recordingSessionId: item.recordingSessionId,
                sharedOwners: normalizeOwners(item.sharedOwners),
            })),
    };

    for (const values of Object.values(snapshot)) {
        values.sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
        );
    }

    fs.mkdirSync("/tmp/aclog-phase7-1", {
        recursive: true,
    });

    const output = `/tmp/aclog-phase7-1/${mode}.json`;

    fs.writeFileSync(output, JSON.stringify(snapshot, null, 2));

    console.log(`Snapshot: ${output}`);
    console.log({
        sessions: snapshot.sessions.length,
        grants: snapshot.grants.length,
        operations: snapshot.operations.length,
        logs: snapshot.logs.length,
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
