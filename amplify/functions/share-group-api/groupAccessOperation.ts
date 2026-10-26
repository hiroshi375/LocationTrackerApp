import { assertRecordOwner } from "./recordOwnership";
export { assertRecordOwner } from "./recordOwnership";
import { randomUUID } from "node:crypto";
import { discardRecordingSessionBatch } from "./discardRecordingSession";
import { indexedSessionLogPage, sessionIndexReady } from "./sessionLogIndex";
import {
    UpdateCommand,
    type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
    accessDb,
    tables,
    getRow,
    gate,
    scanRows,
    scanPage,
    queryWork,
    fencedWrite,
    affectsGrant,
    projectedOwners,
    sameOwners,
    type Row,
} from "./groupAccessStore";

type Action = "DELETE" | "DEACTIVATE" | "LEAVE" | "REMOVE";
type Writes = NonNullable<TransactWriteCommandInput["TransactItems"]>;
const jobKey = (groupId: string, operationId: string) => ({
    groupId,
    entryKey: `OP#${operationId}`,
});
const now = () => new Date().toISOString();
const fail = (message: string): never => {
    throw new Error(message);
};
export function groupJobView(job: Row) {
    return {
        success: job.status === "COMPLETED",
        accepted: !["CANCELLED"].includes(job.status),
        operationId: job.operationId,
        groupId: job.groupId,
        groupName: job.groupName,
        status: job.status,
        phase: job.phase,
        message:
            job.errorMessage ??
            (job.status === "COMPLETED"
                ? "共有権限の処理が完了しました。"
                : job.status === "CANCELLED"
                  ? "失効開始前の操作を取り消しました。"
                  : "処理中です。完了までお待ちください。"),
        completedSessionCount: job.completedSessionCount ?? 0,
        canCancel:
            [
                "SNAPSHOT",
                "PREPARE_SESSIONS",
                "PREPARE_LOGS",
                "DISCOVER",
                "NEXT",
            ].includes(job.phase) && !job.startedSession,
    };
}
function authorized(job: Row, userId: string) {
    if (job.requesterUserId !== userId && job.groupOwnerUserId !== userId)
        fail("このグループ操作を参照・変更できません。");
}
export async function getGroupJob(
    groupId: string,
    operationId: string,
    userId: string,
) {
    const job = await getRow(tables.jobs(), jobKey(groupId, operationId));
    if (!job) fail("グループ操作が見つかりません。");
    authorized(job!, userId);
    return job!;
}
export async function requestGroupAccessChange(
    userId: string,
    groupId: string,
    action: Action,
    targetUserId?: string,
    requestId?: string,
) {
    if (
        !groupId?.trim() ||
        !["DELETE", "DEACTIVATE", "LEAVE", "REMOVE"].includes(action)
    )
        fail("グループ操作の指定が不正です。");
    const group = await getRow(tables.groups(), { groupId });
    if (!group) fail("共有グループが見つかりません。");
    const target =
        action === "LEAVE"
            ? userId
            : action === "REMOVE"
              ? targetUserId
              : undefined;
    if (action !== "LEAVE" && group!.ownerUserId !== userId)
        fail("グループ作成者だけが操作できます。");
    // Retries after completion use the persisted request key, not current membership.
    if (requestId) {
        const old = await getRow(tables.jobs(), {
            groupId,
            entryKey: `REQUEST#${userId}#${requestId}`,
        });
        if (old) {
            const previous = await getGroupJob(
                groupId,
                old.operationId,
                userId,
            );
            if (previous.action !== action || previous.targetUserId !== target)
                fail("再送キーが異なる操作に使用されています。");
            return groupJobView(previous);
        }
    }
    if (action === "LEAVE" || action === "REMOVE") {
        if (!target || target === group!.ownerUserId)
            fail("グループ作成者は脱退・除外できません。");
        const membership = await getRow(tables.members(), {
            membershipId: `${groupId}#${target}`,
        });
        if (
            !membership ||
            membership.groupId !== groupId ||
            membership.userId !== target ||
            membership.role === "OWNER"
        )
            fail("対象メンバーを確認できません。");
    }
    const state = await gate(groupId);
    if (state?.activeJobId) {
        const previous = await getGroupJob(groupId, state.activeJobId, userId);
        if (previous.action === action && previous.targetUserId === target)
            return groupJobView(previous);
        fail("このグループには別の操作が進行中です。");
    }
    if (group!.isActive !== true)
        fail("この共有グループは無効または削除済みです。");
    const members = await scanRows(
        tables.members(),
        (row) => row.groupId === groupId,
    );
    if (members.length > 100)
        fail("NEEDS_REPAIR: メンバー件数を確認してください。");
    const operationId = randomUUID();
    const job: Row = {
        ...jobKey(groupId, operationId),
        recordType: "JOB",
        operationId,
        action,
        targetUserId: target,
        requesterUserId: userId,
        groupOwnerUserId: group!.ownerUserId,
        groupName: group!.name,
        memberUserIds: members.map((row) => row.userId),
        memberOwnerValues: members.map((row) => row.ownerValue),
        status: "READY",
        revision: 0,
        phase: "SNAPSHOT",
        createdAt: now(),
        updatedAt: now(),
        completedSessionCount: 0,
    };
    const writes: Writes = [
        {
            Update: {
                TableName: tables.jobs(),
                Key: { groupId, entryKey: "GATE" },
                UpdateExpression: "SET activeJobId = :op",
                ConditionExpression:
                    "attribute_not_exists(activeJobId) AND attribute_not_exists(lockToken)",
                ExpressionAttributeValues: { ":op": operationId },
            },
        },
        {
            Put: {
                TableName: tables.jobs(),
                Item: job,
                ConditionExpression: "attribute_not_exists(groupId)",
            },
        },
        {
            ConditionCheck: {
                TableName: tables.groups(),
                Key: { groupId },
                ConditionExpression:
                    "ownerUserId = :owner AND isActive = :active",
                ExpressionAttributeValues: {
                    ":owner": group!.ownerUserId,
                    ":active": true,
                },
            },
        },
    ];
    if (requestId)
        writes.push({
            Put: {
                TableName: tables.jobs(),
                Item: {
                    groupId,
                    entryKey: `REQUEST#${userId}#${requestId}`,
                    operationId,
                },
                ConditionExpression: "attribute_not_exists(groupId)",
            },
        });
    await fencedWrite(writes);
    return groupJobView(job);
}
export async function resumeGroupJob(
    groupId: string,
    operationId: string,
    userId: string,
) {
    const job = await getGroupJob(groupId, operationId, userId);
    if (["COMPLETED", "CANCELLED", "READY"].includes(job.status))
        return groupJobView(job);
    if (
        job.status === "RUNNING" &&
        (!Number.isFinite(job.lockedUntil) || Date.now() < job.lockedUntil)
    )
        fail("処理は実行中です。");
    await accessDb.send(
        new UpdateCommand({
            TableName: tables.jobs(),
            Key: jobKey(groupId, operationId),
            UpdateExpression:
                "SET #status = :ready, updatedAt = :now, revision = :next REMOVE runToken, errorMessage, lockedUntil",
            ConditionExpression: "#status = :old AND revision = :oldRevision",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
                ":ready": "READY",
                ":old": job.status,
                ":oldRevision": job.revision,
                ":next": job.revision + 1,
                ":now": now(),
            },
        }),
    );
    return groupJobView({ ...job, status: "READY", errorMessage: undefined });
}
export async function cancelGroupJob(
    groupId: string,
    operationId: string,
    userId: string,
) {
    const job = await getGroupJob(groupId, operationId, userId);
    if (
        !groupJobView(job).canCancel ||
        (job.status === "RUNNING" &&
            (!Number.isFinite(job.lockedUntil) || Date.now() < job.lockedUntil))
    )
        fail("失効開始後・実行中の操作は取り消せません。");
    await fencedWrite([
        {
            Update: {
                TableName: tables.jobs(),
                Key: jobKey(groupId, operationId),
                UpdateExpression:
                    "SET #status = :cancel, updatedAt = :now, revision = :next REMOVE runToken",
                ConditionExpression:
                    "#status = :old AND revision = :oldRevision",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                    ":cancel": "CANCELLED",
                    ":old": job.status,
                    ":oldRevision": job.revision,
                    ":next": job.revision + 1,
                    ":now": now(),
                },
            },
        },
        {
            Update: {
                TableName: tables.jobs(),
                Key: { groupId, entryKey: "GATE" },
                UpdateExpression: "REMOVE activeJobId",
                ConditionExpression: "activeJobId = :op",
                ExpressionAttributeValues: { ":op": operationId },
            },
        },
    ]);
    return groupJobView({ ...job, status: "CANCELLED" });
}

// Every chunk writes its checkpoint in the SAME transaction as its data changes.
// Late requests from an expired invocation fail the runToken condition.
function jobFence(job: Row): Writes[number] {
    return {
        ConditionCheck: {
            TableName: tables.jobs(),
            Key: { groupId: job.groupId, entryKey: "GATE" },
            ConditionExpression:
                "activeJobId = :op AND attribute_not_exists(lockToken)",
            ExpressionAttributeValues: { ":op": job.operationId },
        },
    };
}
async function checkpoint(job: Row, changes: Row, writes: Writes = []) {
    const next: Row = {
        ...job,
        ...changes,
        status: "READY",
        revision: job.revision + 1,
        updatedAt: now(),
    };
    delete next.runToken;
    delete next.lockedUntil;
    delete next.errorMessage;
    await fencedWrite([
        jobFence(job),
        ...writes,
        {
            Put: {
                TableName: tables.jobs(),
                Item: next,
                ConditionExpression: "runToken = :token AND #status = :running",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                    ":token": job.runToken,
                    ":running": "RUNNING",
                },
            },
        },
    ]);
}
function sessionFence(job: Row): Writes[number] {
    return {
        ConditionCheck: {
            TableName: tables.operations(),
            Key: { recordingSessionRecordId: job.currentSession.id },
            ConditionExpression:
                "operationId = :id AND groupOperationId = :parent AND #status = :applying",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
                ":id": job.sessionOperationId,
                ":parent": job.operationId,
                ":applying": "APPLYING",
            },
        },
    };
}
async function step(job: Row) {
    const { groupId, operationId, phase } = job;
    if (phase === "SNAPSHOT") {
        const indexedLogs = await sessionIndexReady();
        const members = await scanRows(
            tables.members(),
            (member) => member.groupId === groupId,
        );
        if (
            members.length > 100 ||
            !members.some(
                (member) =>
                    member.userId === job.groupOwnerUserId &&
                    member.role === "OWNER",
            )
        )
            fail("NEEDS_REPAIR: メンバー情報を確認できません。");
        return checkpoint(job, {
            // Published only after complete one-time backfill and legacy audit.
            // Future client writes cannot create sharedOwners or reassign logs.
            phase: indexedLogs ? "DISCOVER" : "PREPARE_SESSIONS",
            indexedLogs,
            memberUserIds: members.map((member) => member.userId),
            memberOwnerValues: members.map((member) => member.ownerValue),
            cursor: undefined,
        });
    }
    if (phase === "PREPARE_SESSIONS") {
        const page = await scanPage(tables.sessions(), job.cursor);
        for (const session of page.Items ?? []) {
            // A legacy record has no trustworthy group provenance. Require the
            // initial migration of all pre-Grant shared records before removal.
            if (!(session.sharedOwners ?? []).length) continue;
            const state = await getRow(tables.operations(), {
                recordingSessionRecordId: session!.id,
            });
            if (state?.grantManaged !== true)
                fail(
                    "NEEDS_MIGRATION: 所属を削除する前に旧共有のGrant移行が必要です。",
                );
        }
        return checkpoint(job, {
            cursor: page.LastEvaluatedKey,
            phase: page.LastEvaluatedKey ? phase : "PREPARE_LOGS",
        });
    }
    if (phase === "PREPARE_LOGS") {
        const page = await scanPage(tables.logs(), job.cursor, 10);
        for (const log of page.Items ?? []) {
            if (!(log.sharedOwners ?? []).length) continue;
            let session = await getRow(tables.sessions(), {
                id: `recording-session:${log.userId}:${log.recordingSessionId}`,
            });
            if (!session) {
                const matches = await scanRows(
                    tables.sessions(),
                    (row) =>
                        row.userId === log.userId &&
                        row.recordingSessionId === log.recordingSessionId,
                );
                if (matches.length === 1) session = matches[0];
            }
            if (!session)
                fail(
                    "NEEDS_MIGRATION: 旧形式または未集約の共有ログがあります。先に移行してください。",
                );
            const state = await getRow(tables.operations(), {
                recordingSessionRecordId: session!.id,
            });
            if (state?.grantManaged !== true)
                fail("NEEDS_MIGRATION: 未移行の共有ログがあります。");
        }
        return checkpoint(job, {
            cursor: page.LastEvaluatedKey,
            phase: page.LastEvaluatedKey ? phase : "DISCOVER",
        });
    }
    if (phase === "DISCOVER") {
        const page = await scanPage(tables.grants(), job.cursor);
        const work = new Map<string, Set<string>>();
        for (const grant of page.Items ?? []) {
            if (
                grant.groupId !== groupId ||
                !affectsGrant(job.action, job.targetUserId, grant)
            )
                continue;
            if (!grant.recordingSessionRecordId || !grant.grantId)
                fail("NEEDS_REPAIR: Grantの識別子が不正です。");
            const ids =
                work.get(grant.recordingSessionRecordId) ?? new Set<string>();
            ids.add(grant.grantId);
            work.set(grant.recordingSessionRecordId, ids);
        }
        const writes: Writes = [...work].map(([sessionId, ids]) => ({
            Update: {
                TableName: tables.jobs(),
                Key: { groupId, entryKey: `WORK#${operationId}#${sessionId}` },
                UpdateExpression:
                    "SET sessionId = :sid, #status = if_not_exists(#status, :pending) ADD grantIds :ids",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                    ":sid": sessionId,
                    ":pending": "PENDING",
                    ":ids": ids,
                },
            },
        }));
        return checkpoint(
            job,
            {
                cursor: page.LastEvaluatedKey,
                phase: page.LastEvaluatedKey ? phase : "NEXT",
            },
            writes,
        );
    }
    if (phase === "NEXT") {
        const work = await queryWork(groupId, operationId);
        if (!work)
            return checkpoint(job, { phase: "MEMBERS", cursor: undefined });
        const previous = await getRow(tables.operations(), { recordingSessionRecordId: work.sessionId });
        if (previous?.discardOperation === true) {
            if (previous.status !== "DISCARDED") {
                // Finish the owner-authorized deletion before completing group
                // revocation; never leave shared logs behind or revive a tombstone.
                await discardRecordingSessionBatch(previous.ownerUserId, previous.recordingSessionId);
                return checkpoint(job, { phase: "NEXT" });
            }
            return checkpoint(job, { phase: "NEXT" }, [{ Update: {
                TableName: tables.jobs(), Key: { groupId, entryKey: work.entryKey },
                UpdateExpression: "SET #status = :done", ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":done": "COMPLETED" },
            } }]);
        }
        const session = await getRow(tables.sessions(), { id: work.sessionId });
        if (!session) fail("NEEDS_REPAIR: 対象履歴が存在しません。");
        assertRecordOwner(session!, session!.userId);
        if (previous?.grantManaged !== true || previous.status !== "COMPLETED")
            fail(
                "WAITING_REPAIR: 対象履歴が未移行または別の共有操作の復旧待ちです。",
            );
        const sessionOperationId = randomUUID();
        const child = {
            recordingSessionRecordId: session!.id,
            operationId: sessionOperationId,
            ownerUserId: session!.userId,
            status: "APPLYING",
            grantManaged: true,
            groupOperationId: operationId,
            operationPhase: "GROUP_REVOKING",
            requestedAt: now(),
            updatedAt: now(),
        };
        return checkpoint(
            job,
            {
                phase: "GRANTS",
                currentWorkKey: work.entryKey,
                currentSession: {
                    id: session!.id,
                    userId: session!.userId,
                    recordingSessionId: session!.recordingSessionId,
                },
                sessionOperationId,
                targetGrantIds: [...work.grantIds].sort(),
                grantIndex: 0,
                startedSession: true,
                cursor: undefined,
            },
            [
                {
                    Put: {
                        TableName: tables.operations(),
                        Item: child,
                        ConditionExpression:
                            "operationId = :old AND #status = :completed AND grantManaged = :yes",
                        ExpressionAttributeNames: { "#status": "status" },
                        ExpressionAttributeValues: {
                            ":old": previous!.operationId,
                            ":completed": "COMPLETED",
                            ":yes": true,
                        },
                    },
                },
            ],
        );
    }
    if (phase === "GRANTS") {
        const id = job.targetGrantIds[job.grantIndex];
        if (!id) {
            const grants = await scanRows(
                tables.grants(),
                (g) => g.recordingSessionRecordId === job.currentSession.id,
            );
            return checkpoint(
                job,
                {
                    phase: "LOGS",
                    desiredOwners: projectedOwners(
                        grants,
                        job.currentSession.id,
                    ),
                    cursor: undefined,
                    updatedLogCount: 0,
                },
                [sessionFence(job)],
            );
        }
        const grant = await getRow(tables.grants(), { grantId: id });
        if (
            !grant ||
            grant.groupId !== groupId ||
            grant.recordingSessionRecordId !== job.currentSession.id ||
            grant.ownerUserId !== job.currentSession.userId ||
            !affectsGrant(job.action, job.targetUserId, grant)
        )
            fail("NEEDS_REPAIR: 失効対象Grantが一致しません。");
        return checkpoint(job, { grantIndex: job.grantIndex + 1 }, [
            sessionFence(job),
            {
                Update: {
                    TableName: tables.grants(),
                    Key: { grantId: id },
                    UpdateExpression:
                        "SET isActive = :no, revokedAt = :at, updatedAt = :now",
                    ConditionExpression:
                        "groupId = :g AND recordingSessionRecordId = :sid AND ownerUserId = :owner",
                    ExpressionAttributeValues: {
                        ":no": false,
                        ":at":
                            grant!.isActive || !grant!.revokedAt
                                ? now()
                                : grant!.revokedAt,
                        ":now": now(),
                        ":g": groupId,
                        ":sid": job.currentSession.id,
                        ":owner": job.currentSession.userId,
                    },
                },
            },
        ]);
    }
    if (phase === "LOGS" || phase === "VERIFY_LOGS") {
        const page = job.indexedLogs
            ? await indexedSessionLogPage(job.currentSession.userId,
                job.currentSession.recordingSessionId, job.cursor)
            : await scanPage(tables.logs(), job.cursor);
        const writes: Writes = [sessionFence(job)];
        let count = 0;
        for (const log of page.Items ?? []) {
            if (
                log.recordingSessionId !==
                    job.currentSession.recordingSessionId ||
                log.userId !== job.currentSession.userId
            )
                continue;
            assertRecordOwner(log, job.currentSession.userId);
            count++;
            if (phase === "VERIFY_LOGS") {
                if (!sameOwners(log.sharedOwners, job.desiredOwners))
                    fail("NEEDS_REPAIR: ログの投影検証が一致しません。");
            } else if (!sameOwners(log.sharedOwners, job.desiredOwners))
                writes.push({
                    Update: {
                        TableName: tables.logs(),
                        Key: { id: log.id },
                        UpdateExpression:
                            "SET sharedOwners = :owners, updatedAt = :now",
                        ConditionExpression:
                            "userId = :user AND recordingSessionId = :sid AND #owner = :owner",
                        ExpressionAttributeNames: { "#owner": "owner" },
                        ExpressionAttributeValues: {
                            ":owners": job.desiredOwners,
                            ":now": now(),
                            ":user": log.userId,
                            ":sid": log.recordingSessionId,
                            ":owner": log.owner,
                        },
                    },
                });
        }
        return checkpoint(
            job,
            {
                cursor: page.LastEvaluatedKey,
                phase: page.LastEvaluatedKey
                    ? phase
                    : phase === "LOGS"
                      ? "VERIFY_LOGS"
                      : "SESSION",
                updatedLogCount:
                    phase === "LOGS"
                        ? job.updatedLogCount + count
                        : job.updatedLogCount,
            },
            writes,
        );
    }
    if (phase === "SESSION") {
        const grants = await scanRows(
            tables.grants(),
            (g) => g.recordingSessionRecordId === job.currentSession.id,
        );
        if (
            !sameOwners(
                projectedOwners(grants, job.currentSession.id),
                job.desiredOwners,
            )
        )
            fail("NEEDS_REPAIR: 検証中に有効Grantが変化しました。");
        return checkpoint(job, { phase: "VERIFY_SESSION" }, [
            sessionFence(job),
            {
                Update: {
                    TableName: tables.sessions(),
                    Key: { id: job.currentSession.id },
                    UpdateExpression:
                        "SET sharedOwners = :owners, updatedAt = :now",
                    ConditionExpression:
                        "userId = :user AND recordingSessionId = :sid",
                    ExpressionAttributeValues: {
                        ":owners": job.desiredOwners,
                        ":now": now(),
                        ":user": job.currentSession.userId,
                        ":sid": job.currentSession.recordingSessionId,
                    },
                },
            },
        ]);
    }
    if (phase === "VERIFY_SESSION") {
        const session = await getRow(tables.sessions(), {
            id: job.currentSession.id,
        });
        if (!session || !sameOwners(session.sharedOwners, job.desiredOwners))
            fail("NEEDS_REPAIR: セッションの投影検証が一致しません。");
        return checkpoint(
            job,
            {
                phase: "NEXT",
                currentSession: undefined,
                completedSessionCount: job.completedSessionCount + 1,
            },
            [
                {
                    Update: {
                        TableName: tables.operations(),
                        Key: {
                            recordingSessionRecordId: job.currentSession.id,
                        },
                        UpdateExpression:
                            "SET #status = :done, completedAt = :now, updatedAt = :now",
                        ConditionExpression:
                            "operationId = :id AND groupOperationId = :parent AND #status = :applying",
                        ExpressionAttributeNames: { "#status": "status" },
                        ExpressionAttributeValues: {
                            ":done": "COMPLETED",
                            ":now": now(),
                            ":id": job.sessionOperationId,
                            ":parent": operationId,
                            ":applying": "APPLYING",
                        },
                    },
                },
                {
                    Update: {
                        TableName: tables.jobs(),
                        Key: { groupId, entryKey: job.currentWorkKey },
                        UpdateExpression: "SET #status = :done",
                        ExpressionAttributeNames: { "#status": "status" },
                        ExpressionAttributeValues: { ":done": "COMPLETED" },
                    },
                },
            ],
        );
    }
    if (phase === "MEMBERS") {
        if (job.action === "DEACTIVATE")
            return checkpoint(job, { phase: "FINALIZE" });
        const page = await scanPage(tables.members(), job.cursor);
        const writes: Writes = [];
        for (const member of page.Items ?? []) {
            if (
                member.groupId !== groupId ||
                (job.action !== "DELETE" && member.userId !== job.targetUserId)
            )
                continue;
            writes.push({
                Delete: {
                    TableName: tables.members(),
                    Key: { membershipId: member.membershipId },
                    ConditionExpression: "groupId = :g AND userId = :u",
                    ExpressionAttributeValues: {
                        ":g": groupId,
                        ":u": member.userId,
                    },
                },
            });
        }
        return checkpoint(
            job,
            {
                cursor: page.LastEvaluatedKey,
                phase: page.LastEvaluatedKey ? phase : "FINALIZE",
            },
            writes,
        );
    }
    if (phase === "FINALIZE") {
        const terminal = job.action === "DELETE" || job.action === "DEACTIVATE";
        const completed: Row = {
            ...job,
            status: "COMPLETED",
            revision: job.revision + 1,
            updatedAt: now(),
            completedAt: now(),
        };
        delete completed.runToken;
        delete completed.lockedUntil;
        await fencedWrite([
            {
                Put: {
                    TableName: tables.jobs(),
                    Item: completed,
                    ConditionExpression:
                        "runToken = :token AND #status = :running",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                        ":token": job.runToken,
                        ":running": "RUNNING",
                    },
                },
            },
            {
                Update: {
                    TableName: tables.jobs(),
                    Key: { groupId, entryKey: "GATE" },
                    UpdateExpression:
                        "SET lastOperationId = :op REMOVE activeJobId",
                    ConditionExpression:
                        "activeJobId = :op AND attribute_not_exists(lockToken)",
                    ExpressionAttributeValues: { ":op": operationId },
                },
            },
            {
                Update: {
                    TableName: tables.groups(),
                    Key: { groupId },
                    UpdateExpression:
                        "SET isActive = :active, lifecycle = :state, updatedAt = :now",
                    ConditionExpression: "ownerUserId = :owner",
                    ExpressionAttributeValues: {
                        ":active": !terminal,
                        ":state":
                            job.action === "DELETE"
                                ? "DELETED"
                                : job.action === "DEACTIVATE"
                                  ? "DISABLED"
                                  : "ACTIVE",
                        ":now": now(),
                        ":owner": job.groupOwnerUserId,
                    },
                },
            },
        ]);
        return;
    }
    fail("NEEDS_REPAIR: 不明な処理段階です。");
}
export async function advanceGroupJob(groupId: string, operationId: string) {
    const job = await getRow(tables.jobs(), jobKey(groupId, operationId));
    if (!job || job.status !== "READY") return;
    const token = randomUUID();
    try {
        await accessDb.send(
            new UpdateCommand({
                TableName: tables.jobs(),
                Key: jobKey(groupId, operationId),
                UpdateExpression:
                    "SET #status = :running, runToken = :token, lockedUntil = :until, updatedAt = :now, revision = :next",
                ConditionExpression: "#status = :ready AND revision = :old",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                    ":ready": "READY",
                    ":running": "RUNNING",
                    ":token": token,
                    ":until": Date.now() + 90000,
                    ":now": now(),
                    ":old": job.revision,
                    ":next": job.revision + 1,
                },
            }),
        );
    } catch (error) {
        if ((error as Error).name === "ConditionalCheckFailedException") return;
        throw error;
    }
    try {
        await step({
            ...job,
            runToken: token,
            revision: job.revision + 1,
            status: "RUNNING",
        });
        console.info("[GroupAccess] Chunk committed", {
            groupId,
            operationId,
            phase: job.phase,
        });
    } catch (error) {
        console.error("[GroupAccess] Chunk failed", {
            groupId,
            operationId,
            phase: job.phase,
            errorType: (error as Error).name,
        });
        try {
            await accessDb.send(
                new UpdateCommand({
                    TableName: tables.jobs(),
                    Key: jobKey(groupId, operationId),
                    UpdateExpression:
                        "SET #status = :failed, errorMessage = :error, updatedAt = :now, revision = :revision REMOVE runToken, lockedUntil",
                    ConditionExpression: "runToken = :token",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                        ":failed": "FAILED",
                        ":revision": job.revision + 2,
                        ":error":
                            error instanceof Error
                                ? error.message.slice(0, 300)
                                : "処理に失敗しました。",
                        ":now": now(),
                        ":token": token,
                    },
                }),
            );
        } catch {
            /* A committed checkpoint or a newer invocation must not be overwritten. */
        }
    }
}
// Preserve the same per-chunk CAS/checkpoint; coalesce stream dispatch overhead.
// The time bound leaves headroom within the 30s Lambda. A slow call still uses
// the existing lease/watchdog recovery, never an uncheckpointed optimistic result.
export async function advanceGroupJobBatch(groupId: string, operationId: string) {
    const deadline = Date.now() + 12000;
    for (let i = 0; i < 24 && Date.now() < deadline; i++) {
        const job = await getRow(tables.jobs(), jobKey(groupId, operationId));
        if (job?.status !== "READY") return;
        await advanceGroupJob(groupId, operationId);
    }
}
// A scheduled reconciliation recovers hard-timeout jobs and missed stream dispatch.
export async function reconcileGroupJobs() {
    // The scheduler passes the cursor back through a persistent watchdog row.
    const watch = await getRow(tables.jobs(), {
        groupId: "__WATCHDOG__",
        entryKey: "CURSOR",
    });
    const batch = await scanPage(tables.jobs(), watch?.cursor);
    for (const job of batch.Items ?? []) {
        if (
            job.entryKey === "GATE" &&
            job.lockToken &&
            !job.activeJobId &&
            Date.now() - Date.parse(job.lockStartedAt) > 90000
        ) {
            // All admitted data mutations carry this token in their transaction.
            // Removing it fences off even a delayed request from the old 30s Lambda.
            await accessDb.send(
                new UpdateCommand({
                    TableName: tables.jobs(),
                    Key: { groupId: job.groupId, entryKey: "GATE" },
                    UpdateExpression: "REMOVE lockToken, lockStartedAt",
                    ConditionExpression:
                        "lockToken = :token AND attribute_not_exists(activeJobId)",
                    ExpressionAttributeValues: { ":token": job.lockToken },
                }),
            );
        }
        if (job.recordType !== "JOB") continue;
        if (
            (job.status === "RUNNING" && Date.now() > job.lockedUntil) ||
            (job.status === "READY" &&
                Date.now() - Date.parse(job.updatedAt) > 90000)
        ) {
            await resumeGroupJob(
                job.groupId,
                job.operationId,
                job.requesterUserId,
            );
            // READY jobs need a fresh stream event if the original one was lost.
            if (job.status === "READY")
                await accessDb.send(
                    new UpdateCommand({
                        TableName: tables.jobs(),
                        Key: jobKey(job.groupId, job.operationId),
                        UpdateExpression:
                            "SET updatedAt = :now ADD revision :one",
                        ConditionExpression: "#s = :ready",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: {
                            ":now": now(),
                            ":ready": "READY",
                            ":one": 1,
                        },
                    }),
                );
        }
    }
    await accessDb.send(
        new UpdateCommand({
            TableName: tables.jobs(),
            Key: { groupId: "__WATCHDOG__", entryKey: "CURSOR" },
            UpdateExpression: batch.LastEvaluatedKey
                ? "SET #cursor = :cursor"
                : "REMOVE #cursor",
            ExpressionAttributeNames: { "#cursor": "cursor" },
            ...(batch.LastEvaluatedKey
                ? {
                      ExpressionAttributeValues: {
                          ":cursor": batch.LastEvaluatedKey,
                      },
                  }
                : {}),
        }),
    );
}
