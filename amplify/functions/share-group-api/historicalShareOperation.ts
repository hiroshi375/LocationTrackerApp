import { groupFences, requireGroupCoverage } from "./groupAccessStore";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    UpdateCommand,
    GetCommand,
    TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function getTableName(): string {
    const value = process.env.HISTORICAL_SHARE_OPERATION_TABLE_NAME;

    if (!value) {
        throw new Error("HISTORICAL_SHARE_OPERATION_TABLE_NAMEが未設定です。");
    }

    return value;
}

function getHistoricalGrantTableName(): string {
    const value = process.env.HISTORICAL_SHARE_GRANT_TABLE_NAME;

    if (!value) {
        throw new Error("HISTORICAL_SHARE_GRANT_TABLE_NAMEが未設定です。");
    }

    return value;
}

export type HistoricalShareOperationStatus =
    | "PENDING"
    | "APPLYING"
    | "COMPLETED"
    | "FAILED"
    | "DISCARDING"
    | "DISCARDED";

export type HistoricalShareOperationPhase =
    | "INTENT_RECORDED"
    | "GRANT_WRITE_CONFIRMED"
    | "GROUP_REVOKING";

export type HistoricalShareOperation = {
    recordingSessionRecordId: string;
    operationId: string;
    ownerUserId: string;
    status: HistoricalShareOperationStatus;

    grantManaged?: boolean;
    discardOperation?: boolean;
    recordingSessionId?: string;

    requestedAt: string;
    updatedAt: string;
    completedAt?: string;
    errorMessage?: string;

    // 今回追加する復旧用情報
    groupId?: string;
    recipientUserId?: string;
    requestedEnabled?: boolean;
    grantId?: string;
    operationPhase?: HistoricalShareOperationPhase;
    intentRecordedAt?: string;
    grantWriteConfirmedAt?: string;
    recoveredFromOperationId?: string;
    recoveryStartedAt?: string;
};

/**
 * DynamoDBの条件付き書き込み失敗か判定する。
 */
function isConditionalFailure(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
    );
}

/**
 * セッション単位の共有操作を開始する。
 *
 * - 操作が存在しなければPENDINGを作成
 * - 前回COMPLETEDなら新しい操作を開始
 * - PENDING/APPLYING/FAILEDなら競合として拒否
 *
 * ロックには自動有効期限を設けない。
 * 途中停止した処理の安全な復旧が完成するまでは、
 * 不用意なロック解放を防ぐ。
 */
export async function beginHistoricalShareOperation(
    recordingSessionRecordId: string,
    ownerUserId: string,
): Promise<HistoricalShareOperation> {
    if (!recordingSessionRecordId.trim() || !ownerUserId.trim()) {
        throw new Error("共有操作の対象または所有者が不正です。");
    }

    const now = new Date().toISOString();

    const operation: HistoricalShareOperation = {
        recordingSessionRecordId,
        operationId: randomUUID(),
        ownerUserId,
        status: "PENDING",
        grantManaged: false,
        requestedAt: now,
        updatedAt: now,
    };

    try {
        await db.send(
            new UpdateCommand({
                TableName: getTableName(),

                Key: {
                    recordingSessionRecordId,
                },

                UpdateExpression:
                    "SET #operationId = :operationId, " +
                    "#ownerUserId = :ownerUserId, " +
                    "#status = :pending, " +
                    "#requestedAt = :now, " +
                    "#updatedAt = :now, " +
                    "#grantManaged = if_not_exists(#grantManaged, :false) " +
                    "REMOVE #completedAt, #errorMessage, " +
                    "#groupId, #recipientUserId, #requestedEnabled, " +
                    "#grantId, #operationPhase, #intentRecordedAt, " +
                    "#grantWriteConfirmedAt, #recoveredFromOperationId, " +
                    "#recoveryStartedAt",

                ConditionExpression:
                    "attribute_not_exists(#pk) OR " +
                    "(#status = :completed AND #ownerUserId = :ownerUserId)",

                ExpressionAttributeNames: {
                    "#pk": "recordingSessionRecordId",
                    "#operationId": "operationId",
                    "#ownerUserId": "ownerUserId",
                    "#status": "status",
                    "#requestedAt": "requestedAt",
                    "#updatedAt": "updatedAt",
                    "#grantManaged": "grantManaged",
                    "#completedAt": "completedAt",
                    "#errorMessage": "errorMessage",
                    "#groupId": "groupId",
                    "#recipientUserId": "recipientUserId",
                    "#requestedEnabled": "requestedEnabled",
                    "#grantId": "grantId",
                    "#operationPhase": "operationPhase",
                    "#intentRecordedAt": "intentRecordedAt",
                    "#grantWriteConfirmedAt": "grantWriteConfirmedAt",
                    "#recoveredFromOperationId": "recoveredFromOperationId",
                    "#recoveryStartedAt": "recoveryStartedAt",
                },

                ExpressionAttributeValues: {
                    ":operationId": operation.operationId,
                    ":ownerUserId": ownerUserId,
                    ":pending": "PENDING",
                    ":completed": "COMPLETED",
                    ":false": false,
                    ":now": now,
                },

                ReturnValues: "ALL_NEW",
            }),
        );
    } catch (error) {
        if (isConditionalFailure(error)) {
            throw new Error(
                "このRecordingSessionは共有操作中、または復旧待ちです。",
            );
        }

        throw error;
    }

    return operation;
}

/**
 * 実レコードへの共有権限反映を開始する。
 *
 * PENDING → APPLYING
 *
 * 自分のoperationIdと現在の状態が一致した場合のみ更新。
 */
export async function markHistoricalShareApplying(
    operation: HistoricalShareOperation,
): Promise<void> {
    await db.send(
        new UpdateCommand({
            TableName: getTableName(),

            Key: {
                recordingSessionRecordId: operation.recordingSessionRecordId,
            },

            UpdateExpression: "SET #status = :applying, #updatedAt = :now",

            ConditionExpression:
                "#operationId = :operationId AND #status = :pending",

            ExpressionAttributeNames: {
                "#status": "status",
                "#updatedAt": "updatedAt",
                "#operationId": "operationId",
            },

            ExpressionAttributeValues: {
                ":operationId": operation.operationId,
                ":pending": "PENDING",
                ":applying": "APPLYING",
                ":now": new Date().toISOString(),
            },
        }),
    );
}

/**
 * 全レコードへの共有権限反映と検証が
 * 完了した場合のみ呼び出す。
 *
 * APPLYING → COMPLETED
 */
export async function completeHistoricalShareOperation(
    operation: HistoricalShareOperation,
): Promise<void> {
    const now = new Date().toISOString();

    await db.send(
        new UpdateCommand({
            TableName: getTableName(),

            Key: {
                recordingSessionRecordId: operation.recordingSessionRecordId,
            },

            UpdateExpression:
                "SET #status = :completed, #updatedAt = :now, " +
                "#completedAt = :now REMOVE #errorMessage",

            ConditionExpression:
                "#operationId = :operationId AND #status = :applying",

            ExpressionAttributeNames: {
                "#status": "status",
                "#updatedAt": "updatedAt",
                "#completedAt": "completedAt",
                "#operationId": "operationId",
                "#errorMessage": "errorMessage",
            },

            ExpressionAttributeValues: {
                ":operationId": operation.operationId,
                ":applying": "APPLYING",
                ":completed": "COMPLETED",
                ":now": now,
            },
        }),
    );
}

/**
 * 共有操作の失敗を記録する。
 *
 * PENDING/APPLYING → FAILED
 *
 * FAILEDでもロックは保持する。
 * 部分的に共有権限が反映された可能性があるため、
 * 自動的には新しい操作を許可しない。
 */
export async function failHistoricalShareOperation(
    operation: HistoricalShareOperation,
    error: unknown,
): Promise<void> {
    const message =
        error instanceof Error
            ? error.message
            : "Unknown historical sharing error";

    await db.send(
        new UpdateCommand({
            TableName: getTableName(),

            Key: {
                recordingSessionRecordId: operation.recordingSessionRecordId,
            },

            UpdateExpression:
                "SET #status = :failed, #updatedAt = :now, " +
                "#errorMessage = :message",

            ConditionExpression:
                "#operationId = :operationId AND " +
                "#status IN (:pending, :applying)",

            ExpressionAttributeNames: {
                "#status": "status",
                "#updatedAt": "updatedAt",
                "#errorMessage": "errorMessage",
                "#operationId": "operationId",
            },

            ExpressionAttributeValues: {
                ":operationId": operation.operationId,
                ":pending": "PENDING",
                ":applying": "APPLYING",
                ":failed": "FAILED",
                ":now": new Date().toISOString(),
                ":message": message.slice(0, 500),
            },
        }),
    );
}

/**
 * セッションの現在の共有操作状態を取得する。
 *
 * ConsistentRead=trueで強整合性読み取り。
 */
export async function getHistoricalShareOperation(
    recordingSessionRecordId: string,
): Promise<HistoricalShareOperation | null> {
    if (!recordingSessionRecordId.trim()) {
        throw new Error("RecordingSession IDが不正です。");
    }

    const result = await db.send(
        new GetCommand({
            TableName: getTableName(),

            Key: {
                recordingSessionRecordId,
            },

            ConsistentRead: true,
        }),
    );

    return (result.Item as HistoricalShareOperation | undefined) ?? null;
}

export async function markHistoricalShareGrantManaged(
    operation: HistoricalShareOperation,
): Promise<void> {
    await db.send(
        new UpdateCommand({
            TableName: getTableName(),

            Key: {
                recordingSessionRecordId: operation.recordingSessionRecordId,
            },

            UpdateExpression: "SET #grantManaged = :true, #updatedAt = :now",

            ConditionExpression:
                "#operationId = :operationId AND " +
                "#ownerUserId = :ownerUserId AND " +
                "#status = :pending AND " +
                "#grantManaged = :false",

            ExpressionAttributeNames: {
                "#operationId": "operationId",
                "#ownerUserId": "ownerUserId",
                "#status": "status",
                "#grantManaged": "grantManaged",
                "#updatedAt": "updatedAt",
            },

            ExpressionAttributeValues: {
                ":operationId": operation.operationId,
                ":ownerUserId": operation.ownerUserId,
                ":pending": "PENDING",
                ":false": false,
                ":true": true,
                ":now": new Date().toISOString(),
            },
        }),
    );
}

/**
 * 共有操作の内容をGrant更新より前に永続化する。
 *
 * 必ずbeginHistoricalShareOperation()の成功後に呼び出す。
 * operationIdとownerUserIdを条件に含め、
 * 別操作による更新を拒否する。
 */
export async function recordHistoricalShareIntent(
    operation: HistoricalShareOperation,
    input: {
        groupId: string;
        recipientUserId: string;
        enabled: boolean;
        grantId: string;
    },
): Promise<void> {
    if (
        !input.groupId.trim() ||
        !input.recipientUserId.trim() ||
        !input.grantId.trim()
    ) {
        throw new Error("共有操作情報が不正です。");
    }

    const now = new Date().toISOString();

    await db.send(
        new UpdateCommand({
            TableName: getTableName(),

            Key: {
                recordingSessionRecordId: operation.recordingSessionRecordId,
            },

            UpdateExpression:
                "SET #groupId = :groupId, " +
                "#recipientUserId = :recipientUserId, " +
                "#requestedEnabled = :enabled, " +
                "#grantId = :grantId, " +
                "#operationPhase = :phase, " +
                "#intentRecordedAt = :now, " +
                "#updatedAt = :now " +
                "REMOVE #grantWriteConfirmedAt",

            ConditionExpression:
                "#operationId = :operationId AND " +
                "#ownerUserId = :ownerUserId AND " +
                "#status = :pending",

            ExpressionAttributeNames: {
                "#operationId": "operationId",
                "#ownerUserId": "ownerUserId",
                "#status": "status",
                "#groupId": "groupId",
                "#recipientUserId": "recipientUserId",
                "#requestedEnabled": "requestedEnabled",
                "#grantId": "grantId",
                "#operationPhase": "operationPhase",
                "#intentRecordedAt": "intentRecordedAt",
                "#grantWriteConfirmedAt": "grantWriteConfirmedAt",
                "#updatedAt": "updatedAt",
            },

            ExpressionAttributeValues: {
                ":operationId": operation.operationId,
                ":ownerUserId": operation.ownerUserId,
                ":pending": "PENDING",
                ":groupId": input.groupId,
                ":recipientUserId": input.recipientUserId,
                ":enabled": input.enabled,
                ":grantId": input.grantId,
                ":phase": "INTENT_RECORDED",
                ":now": now,
            },
        }),
    );
}

/**
 * Grantの登録・解除が成功したことを記録する。
 *
 * Grant更新とこの状態更新はトランザクションではない。
 * そのため復旧時には、実際のGrantを再取得して確認する。
 */
export async function markHistoricalGrantWriteConfirmed(
    operation: HistoricalShareOperation,
): Promise<void> {
    const now = new Date().toISOString();

    await db.send(
        new UpdateCommand({
            TableName: getTableName(),

            Key: {
                recordingSessionRecordId: operation.recordingSessionRecordId,
            },

            UpdateExpression:
                "SET #operationPhase = :confirmed, " +
                "#grantWriteConfirmedAt = :now, " +
                "#updatedAt = :now",

            ConditionExpression:
                "#operationId = :operationId AND " +
                "#ownerUserId = :ownerUserId AND " +
                "#status = :pending AND " +
                "#operationPhase = :intent",

            ExpressionAttributeNames: {
                "#operationId": "operationId",
                "#ownerUserId": "ownerUserId",
                "#status": "status",
                "#operationPhase": "operationPhase",
                "#grantWriteConfirmedAt": "grantWriteConfirmedAt",
                "#updatedAt": "updatedAt",
            },

            ExpressionAttributeValues: {
                ":operationId": operation.operationId,
                ":ownerUserId": operation.ownerUserId,
                ":pending": "PENDING",
                ":intent": "INTENT_RECORDED",
                ":confirmed": "GRANT_WRITE_CONFIRMED",
                ":now": now,
            },
        }),
    );
}

/**
 * ⑥-F-4専用：
 * 既存共有先のGrant作成とGrant管理状態の確定を
 * 1つのDynamoDBトランザクションで実行する。
 *
 * 成功時：
 * - Grantが新規作成される
 * - operationPhase = GRANT_WRITE_CONFIRMED
 * - grantManaged = true
 *
 * 失敗時：
 * - 両方とも書き込まれない
 *
 * 既存Grantがある場合の上書きは禁止。
 */
export async function commitHistoricalMigrationGrant(
    operation: HistoricalShareOperation,
    input: {
        grantId: string;
        groupId: string;
        recipientUserId: string;
        recipientOwnerValue: string;
    },
): Promise<void> {
    if (!(input.recipientOwnerValue === input.recipientUserId || input.recipientOwnerValue.startsWith(`${input.recipientUserId}::`))) throw new Error("共有先の所有者識別子が一致しません。");
    requireGroupCoverage([input.groupId]);
    if (!groupFences().length) throw new Error("共有グループの排他なしで移行できません。");
    if (
        !operation.recordingSessionRecordId.trim() ||
        !operation.operationId.trim() ||
        !operation.ownerUserId.trim() ||
        !input.grantId.trim() ||
        !input.groupId.trim() ||
        !input.recipientUserId.trim() ||
        !input.recipientOwnerValue.trim()
    ) {
        throw new Error("移行Grantの指定が不正です。");
    }

    const expectedGrantId = [
        "historical-grant",
        operation.recordingSessionRecordId,
        input.groupId,
        input.recipientUserId,
    ].join("#");

    if (input.grantId !== expectedGrantId) {
        throw new Error("移行Grant IDが一致しません。");
    }

    const now = new Date().toISOString();

    await db.send(
        new TransactWriteCommand({
            TransactItems: [
                ...groupFences(),
                {
                    Put: {
                        TableName: getHistoricalGrantTableName(),
                        Item: {
                            grantId: input.grantId,
                            recordingSessionRecordId:
                                operation.recordingSessionRecordId,
                            ownerUserId: operation.ownerUserId,
                            groupId: input.groupId,
                            recipientUserId: input.recipientUserId,
                            recipientOwnerValue: input.recipientOwnerValue,
                            isActive: true,
                            grantedAt: now,
                            createdAt: now,
                            updatedAt: now,
                            __typename: "HistoricalShareGrant",
                        },

                        ConditionExpression: "attribute_not_exists(#grantId)",

                        ExpressionAttributeNames: {
                            "#grantId": "grantId",
                        },
                    },
                },
                {
                    Update: {
                        TableName: getTableName(),
                        Key: {
                            recordingSessionRecordId:
                                operation.recordingSessionRecordId,
                        },

                        UpdateExpression:
                            "SET #operationPhase = :confirmed, " +
                            "#grantWriteConfirmedAt = :now, " +
                            "#grantManaged = :true, " +
                            "#updatedAt = :now",

                        ConditionExpression:
                            "#operationId = :operationId AND " +
                            "#ownerUserId = :ownerUserId AND " +
                            "#status = :pending AND " +
                            "#grantManaged = :false AND " +
                            "#operationPhase = :intent AND " +
                            "#grantId = :grantId AND " +
                            "#groupId = :groupId AND " +
                            "#recipientUserId = :recipientUserId AND " +
                            "#requestedEnabled = :true",

                        ExpressionAttributeNames: {
                            "#operationId": "operationId",
                            "#ownerUserId": "ownerUserId",
                            "#status": "status",
                            "#grantManaged": "grantManaged",
                            "#operationPhase": "operationPhase",
                            "#grantWriteConfirmedAt": "grantWriteConfirmedAt",
                            "#updatedAt": "updatedAt",
                            "#grantId": "grantId",
                            "#groupId": "groupId",
                            "#recipientUserId": "recipientUserId",
                            "#requestedEnabled": "requestedEnabled",
                        },

                        ExpressionAttributeValues: {
                            ":operationId": operation.operationId,
                            ":ownerUserId": operation.ownerUserId,
                            ":pending": "PENDING",
                            ":false": false,
                            ":true": true,
                            ":intent": "INTENT_RECORDED",
                            ":confirmed": "GRANT_WRITE_CONFIRMED",
                            ":grantId": input.grantId,
                            ":groupId": input.groupId,
                            ":recipientUserId": input.recipientUserId,
                            ":now": now,
                        },
                    },
                },
            ],
        }),
    );
}

/**
 * 旧共有先N人のGrantとgrantManagedフラグを同一トランザクションで確定。
 * 全件成功または全件失敗のため、途中でGrantだけが残らない。
 * DynamoDB TransactWriteItemsは最大100アクション。
 */
export async function commitLegacyShareGrantsAtomically(
    operation: HistoricalShareOperation,
    grants: readonly {
        grantId: string;
        groupId: string;
        recipientUserId: string;
        recipientOwnerValue: string;
    }[],
): Promise<void> {
    requireGroupCoverage(grants.map(grant => grant.groupId));
    if (!groupFences().length) throw new Error("共有グループの排他なしで移行できません。");
    if (grants.length === 0 || grants.length > 99 - groupFences().length) {
        throw new Error("旧共有先の件数が一括移行の上限外です。");
    }
    if (new Set(grants.map((grant) => grant.grantId)).size !== grants.length) {
        throw new Error("旧共有先Grantに重複があります。");
    }
    for (const grant of grants) {
        const expected = [
            "historical-grant", operation.recordingSessionRecordId,
            grant.groupId, grant.recipientUserId,
        ].join("#");
        if (grant.grantId !== expected || !grant.recipientOwnerValue.trim() || !(grant.recipientOwnerValue === grant.recipientUserId || grant.recipientOwnerValue.startsWith(`${grant.recipientUserId}::`))) {
            throw new Error("旧共有先Grantの指定が不正です。");
        }
    }
    const now = new Date().toISOString();
    await db.send(new TransactWriteCommand({
        TransactItems: [
            ...groupFences(),
            ...grants.map((grant) => ({
                Put: {
                    TableName: getHistoricalGrantTableName(),
                    Item: {
                        grantId: grant.grantId,
                        recordingSessionRecordId: operation.recordingSessionRecordId,
                        ownerUserId: operation.ownerUserId,
                        groupId: grant.groupId,
                        recipientUserId: grant.recipientUserId,
                        recipientOwnerValue: grant.recipientOwnerValue,
                        isActive: true,
                        grantedAt: now,
                        createdAt: now,
                        updatedAt: now,
                        __typename: "HistoricalShareGrant",
                    },
                    ConditionExpression: "attribute_not_exists(#grantId)",
                    ExpressionAttributeNames: { "#grantId": "grantId" },
                },
            })),
            {
                Update: {
                    TableName: getTableName(),
                    Key: {
                        recordingSessionRecordId: operation.recordingSessionRecordId,
                    },
                    UpdateExpression:
                        "SET #grantManaged = :true, #updatedAt = :now",
                    ConditionExpression:
                        "#operationId = :operationId AND " +
                        "#ownerUserId = :ownerUserId AND " +
                        "#status = :pending AND " +
                        "#grantManaged = :false AND " +
                        "#operationPhase = :intent",
                    ExpressionAttributeNames: {
                        "#operationId": "operationId",
                        "#ownerUserId": "ownerUserId",
                        "#status": "status",
                        "#grantManaged": "grantManaged",
                        "#operationPhase": "operationPhase",
                        "#updatedAt": "updatedAt",
                    },
                    ExpressionAttributeValues: {
                        ":operationId": operation.operationId,
                        ":ownerUserId": operation.ownerUserId,
                        ":pending": "PENDING",
                        ":false": false,
                        ":true": true,
                        ":intent": "INTENT_RECORDED",
                        ":now": now,
                    },
                },
            },
        ],
    }));
}

export type HistoricalShareRecoveryAssessment = {
    recordingSessionRecordId: string;
    operationId: string | null;
    status: HistoricalShareOperationStatus | null;
    operationPhase: HistoricalShareOperationPhase | null;
    grantManaged: boolean;
    recoveryCandidate: boolean;
    reason: string;
};

/**
 * 操作状態だけを調べる。
 *
 * 実レコードの更新やロック取得は行わない。
 * recoveryCandidate=trueでも、旧Lambdaの終了確認は別途必要。
 */
export async function assessHistoricalShareRecovery(
    recordingSessionRecordId: string,
): Promise<HistoricalShareRecoveryAssessment> {
    const operation = await getHistoricalShareOperation(
        recordingSessionRecordId,
    );

    const base = {
        recordingSessionRecordId,
        operationId: operation?.operationId ?? null,
        status: operation?.status ?? null,
        operationPhase: operation?.operationPhase ?? null,
        grantManaged: operation?.grantManaged === true,
    };

    if (!operation) {
        return {
            ...base,
            recoveryCandidate: false,
            reason: "操作状態が存在しません。",
        };
    }

    if (operation.status === "COMPLETED") {
        return {
            ...base,
            recoveryCandidate: false,
            reason: "操作は完了済みです。",
        };
    }

    if (operation.status !== "FAILED") {
        return {
            ...base,
            recoveryCandidate: false,
            reason: "PENDING/APPLYINGは実行中の可能性があるため復旧対象外です。",
        };
    }

    if (operation.grantManaged !== true) {
        return {
            ...base,
            recoveryCandidate: false,
            reason: "Grant管理への移行が完了していません。",
        };
    }

    if (
        operation.operationPhase !== "GRANT_WRITE_CONFIRMED" ||
        !operation.grantWriteConfirmedAt
    ) {
        return {
            ...base,
            recoveryCandidate: false,
            reason: "Grant書き込みの確認が記録されていません。",
        };
    }

    if (
        !operation.groupId ||
        !operation.recipientUserId ||
        !operation.grantId ||
        typeof operation.requestedEnabled !== "boolean"
    ) {
        return {
            ...base,
            recoveryCandidate: false,
            reason: "復旧に必要な操作情報が不足しています。",
        };
    }

    return {
        ...base,
        recoveryCandidate: true,
        reason: "復旧候補です。旧Lambdaの終了と他の書き込み停止を確認してください。",
    };
}

/**
 * FAILED状態の共有操作を復旧用APPLYINGへ移行する。
 *
 * 呼び出し前提：
 * - 管理者が旧Lambda実行の終了を確認済み
 * - 同じセッションへの他の書き込みが停止している
 * - Grantの状態を検証する準備ができている
 *
 * この関数自体はLambda終了や他の書き込み停止を証明しない。
 * 通常のAppSync mutationから直接呼び出してはいけない。
 */
export async function beginHistoricalShareRecovery(
    recordingSessionRecordId: string,
    ownerUserId: string,
    expectedFailedOperationId: string,
): Promise<HistoricalShareOperation> {
    if (
        !recordingSessionRecordId.trim() ||
        !ownerUserId.trim() ||
        !expectedFailedOperationId.trim()
    ) {
        throw new Error("復旧対象の指定が不正です。");
    }

    const recoveryOperationId = randomUUID();
    const now = new Date().toISOString();

    try {
        const result = await db.send(
            new UpdateCommand({
                TableName: getTableName(),

                Key: {
                    recordingSessionRecordId,
                },

                UpdateExpression:
                    "SET #operationId = :newOperationId, " +
                    "#status = :applying, " +
                    "#updatedAt = :now, " +
                    "#recoveredFromOperationId = :oldOperationId, " +
                    "#recoveryStartedAt = :now " +
                    "REMOVE #errorMessage",

                ConditionExpression:
                    "#operationId = :oldOperationId AND " +
                    "#ownerUserId = :ownerUserId AND " +
                    "#status = :failed AND " +
                    "#grantManaged = :true AND " +
                    "#operationPhase = :confirmed AND " +
                    "attribute_exists(#grantId) AND " +
                    "attribute_exists(#grantWriteConfirmedAt)",

                ExpressionAttributeNames: {
                    "#operationId": "operationId",
                    "#ownerUserId": "ownerUserId",
                    "#status": "status",
                    "#updatedAt": "updatedAt",
                    "#grantManaged": "grantManaged",
                    "#operationPhase": "operationPhase",
                    "#grantId": "grantId",
                    "#grantWriteConfirmedAt": "grantWriteConfirmedAt",
                    "#recoveredFromOperationId": "recoveredFromOperationId",
                    "#recoveryStartedAt": "recoveryStartedAt",
                    "#errorMessage": "errorMessage",
                },

                ExpressionAttributeValues: {
                    ":oldOperationId": expectedFailedOperationId,
                    ":newOperationId": recoveryOperationId,
                    ":ownerUserId": ownerUserId,
                    ":failed": "FAILED",
                    ":applying": "APPLYING",
                    ":true": true,
                    ":confirmed": "GRANT_WRITE_CONFIRMED",
                    ":now": now,
                },

                ReturnValues: "ALL_NEW",
            }),
        );

        if (!result.Attributes) {
            throw new Error("復旧ロックの取得結果がありません。");
        }

        return result.Attributes as HistoricalShareOperation;
    } catch (error) {
        if (isConditionalFailure(error)) {
            throw new Error(
                "復旧対象の状態が変更されたか、復旧条件を満たしていません。",
            );
        }

        throw error;
    }
}
