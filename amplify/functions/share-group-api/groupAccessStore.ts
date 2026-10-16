import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    GetCommand,
    ScanCommand,
    QueryCommand,
    UpdateCommand,
    TransactWriteCommand,
    type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

export const accessDb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
});
export function accessTable(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment: ${name}`);
    return value;
}
export const tables = {
    jobs: () => accessTable("GROUP_ACCESS_OPERATION_TABLE_NAME"),
    groups: () => accessTable("SHARE_GROUP_TABLE_NAME"),
    members: () => accessTable("SHARE_GROUP_MEMBER_TABLE_NAME"),
    grants: () => accessTable("HISTORICAL_SHARE_GRANT_TABLE_NAME"),
    sessions: () => accessTable("HISTORICAL_RECORDING_SESSION_TABLE_NAME"),
    logs: () => accessTable("HISTORICAL_LOCATION_LOG_TABLE_NAME"),
    operations: () => accessTable("HISTORICAL_SHARE_OPERATION_TABLE_NAME"),
};
export type Row = Record<string, any>;
export async function getRow(
    table: string,
    key: Row,
): Promise<Row | undefined> {
    return (
        await accessDb.send(
            new GetCommand({
                TableName: table,
                Key: key,
                ConsistentRead: true,
            }),
        )
    ).Item;
}
export async function scanPage(table: string, cursor?: Row, limit = 50) {
    return accessDb.send(
        new ScanCommand({
            TableName: table,
            ConsistentRead: true,
            Limit: limit,
            ExclusiveStartKey: cursor,
        }),
    );
}
export async function scanRows(
    table: string,
    predicate: (row: Row) => boolean,
): Promise<Row[]> {
    const rows: Row[] = [];
    let cursor: Row | undefined;
    do {
        const page = await scanPage(table, cursor);
        rows.push(...(page.Items ?? []).filter(predicate));
        cursor = page.LastEvaluatedKey;
    } while (cursor);
    return rows;
}
export async function queryWork(
    groupId: string,
    operationId: string,
): Promise<Row | undefined> {
    let cursor: Row | undefined;
    do {
        const page = await accessDb.send(
            new QueryCommand({
                TableName: tables.jobs(),
                KeyConditionExpression:
                    "groupId = :g AND begins_with(entryKey, :prefix)",
                ExpressionAttributeValues: {
                    ":g": groupId,
                    ":prefix": `WORK#${operationId}#`,
                },
                ConsistentRead: true,
                Limit: 50,
                ExclusiveStartKey: cursor,
            }),
        );
        const work = page.Items?.find((row) => row.status !== "COMPLETED");
        if (work) return work;
        cursor = page.LastEvaluatedKey;
    } while (cursor);
    return undefined;
}
export async function gate(groupId: string) {
    return getRow(tables.jobs(), { groupId, entryKey: "GATE" });
}
export async function assertGroupAvailable(groupId: string) {
    const state = await gate(groupId);
    if (state?.activeJobId || state?.lockToken)
        throw new Error("共有グループは処理中または復旧待ちです。");
}
type Fence = { groupId: string; token: string };
const context = new AsyncLocalStorage<Fence[]>();
export function groupFences(): NonNullable<
    TransactWriteCommandInput["TransactItems"]
> {
    return (context.getStore() ?? []).map(({ groupId, token }) => ({
        ConditionCheck: {
            TableName: tables.jobs(),
            Key: { groupId, entryKey: "GATE" },
            ConditionExpression:
                "lockToken = :token AND attribute_not_exists(activeJobId)",
            ExpressionAttributeValues: { ":token": token },
        },
    }));
}
export function requireGroupCoverage(groupIds: string[]) {
    const held = new Set(
        (context.getStore() ?? []).map((item) => item.groupId),
    );
    if (groupIds.some((id) => !held.has(id)))
        throw new Error(
            "所属グループが変化しました。共有状態を再取得してください。",
        );
}
export async function fencedWrite(
    items: NonNullable<TransactWriteCommandInput["TransactItems"]>,
) {
    const all = [...groupFences(), ...items];
    if (all.length > 100)
        throw new Error("共有操作の一括更新上限を超えています。");
    const command = new TransactWriteCommand({ TransactItems: all, ClientRequestToken: randomUUID() });
    for (let attempt = 0; ; attempt++) {
        try {
            return await accessDb.send(command);
        } catch (error) {
            const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
            const reasons = failure.CancellationReasons ?? [];
            // Retry only an explicitly cancelled transaction with transient
            // conflicts. A failed condition means the fence/record changed.
            const conflict = failure.name === "TransactionCanceledException" &&
                reasons.some(reason => reason.Code === "TransactionConflict") &&
                reasons.every(reason => !reason.Code || reason.Code === "None" || reason.Code === "TransactionConflict");
            if (!conflict || attempt >= 4) throw error;
            await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt + Math.floor(Math.random() * 25)));
        }
    }
}
export async function withGroupLocks<T>(
    groupIds: string[],
    fn: () => Promise<T>,
): Promise<T> {
    if (context.getStore())
        throw new Error("共有グループロックの入れ子は許可されていません。");
    const held: Fence[] = [];
    try {
        for (const groupId of [...new Set(groupIds)].sort()) {
            const token = randomUUID();
            await accessDb.send(
                new UpdateCommand({
                    TableName: tables.jobs(),
                    Key: { groupId, entryKey: "GATE" },
                    UpdateExpression:
                        "SET lockToken = :token, lockStartedAt = :now",
                    ConditionExpression:
                        "attribute_not_exists(lockToken) AND attribute_not_exists(activeJobId)",
                    ExpressionAttributeValues: {
                        ":token": token,
                        ":now": new Date().toISOString(),
                    },
                }),
            );
            held.push({ groupId, token });
        }
        return await context.run(held, fn);
    } finally {
        for (const { groupId, token } of held.reverse()) {
            try {
                await accessDb.send(
                    new UpdateCommand({
                        TableName: tables.jobs(),
                        Key: { groupId, entryKey: "GATE" },
                        UpdateExpression: "REMOVE lockToken, lockStartedAt",
                        ConditionExpression: "lockToken = :token",
                        ExpressionAttributeValues: { ":token": token },
                    }),
                );
            } catch {
                console.error("[GroupAccess] Lock release requires diagnosis", {
                    groupId,
                });
            }
        }
    }
}
// Acquire every membership involved in possible legacy migration before the session lock.
export async function historicalWriteGroups(
    userId: string,
    requiredGroupId: string,
    recordingSessionId?: string,
): Promise<string[]> {
    if (recordingSessionId) {
        let session = await getRow(tables.sessions(), {
            id: `recording-session:${userId}:${recordingSessionId}`,
        });
        if (!session) {
            const matches = await scanRows(
                tables.sessions(),
                (row) =>
                    row.userId === userId &&
                    row.recordingSessionId === recordingSessionId,
            );
            if (matches.length === 1) session = matches[0];
        }
        if (session) {
            const state = await getRow(tables.operations(), {
                recordingSessionRecordId: session.id,
            });
            if (state?.grantManaged === true) return [requiredGroupId];
        }
    }
    const memberships = await scanRows(
        tables.members(),
        (row) => row.userId === userId,
    );
    const groups = [
        ...new Set([
            requiredGroupId,
            ...memberships.map((row) => row.groupId as string),
        ]),
    ];
    if (groups.length > 20)
        throw new Error(
            "旧共有の移行に関わるグループが多いため、管理者による移行が必要です。",
        );
    return groups;
}

export function affectsGrant(
    action: string,
    targetUserId: string | undefined,
    grant: Row,
): boolean {
    return (
        action === "DELETE" ||
        action === "DEACTIVATE" ||
        (!!targetUserId &&
            (grant.ownerUserId === targetUserId ||
                grant.recipientUserId === targetUserId))
    );
}
export function projectedOwners(grants: Row[], sessionId: string): string[] {
    const owners = new Set<string>();
    for (const grant of grants) {
        if (grant.recordingSessionRecordId !== sessionId)
            throw new Error("異なるセッションのGrantです。");
        if (!grant.isActive) continue;
        if (
            typeof grant.recipientOwnerValue !== "string" ||
            !grant.recipientOwnerValue.trim()
        )
            throw new Error("共有先識別子が不正です。");
        if (
            typeof grant.recipientUserId !== "string" ||
            !(
                grant.recipientOwnerValue === grant.recipientUserId ||
                grant.recipientOwnerValue.startsWith(
                    `${grant.recipientUserId}::`,
                )
            )
        ) {
            throw new Error(
                "NEEDS_REPAIR: Grantの共有先識別子がユーザーと一致しません。",
            );
        }
        owners.add(grant.recipientOwnerValue);
    }
    return [...owners].sort();
}
export function sameOwners(actual: unknown, expected: string[]): boolean {
    const values = actual == null ? [] : actual;
    return (
        Array.isArray(values) &&
        values.length === expected.length &&
        new Set(values).size === values.length &&
        [...values].sort().every((v, i) => v === expected[i])
    );
}
