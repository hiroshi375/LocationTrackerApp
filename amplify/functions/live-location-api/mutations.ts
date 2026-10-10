import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const liveTable = (): string => {
    const name = process.env.LIVE_LOCATION_TABLE_NAME;

    if (!name) {
        throw new Error("Missing environment: LIVE_LOCATION_TABLE_NAME");
    }

    return name;
};

const memberTable = (): string => {
    const name = process.env.SHARE_GROUP_MEMBER_TABLE_NAME;

    if (!name) {
        throw new Error("Missing environment: SHARE_GROUP_MEMBER_TABLE_NAME");
    }

    return name;
};

const groupTable = (): string => {
    const name = process.env.SHARE_GROUP_TABLE_NAME;

    if (!name) {
        throw new Error("Missing environment: SHARE_GROUP_TABLE_NAME");
    }

    return name;
};

export const liveId = (userId: string): string => `live-${userId}`;

function conditionalFailure(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
    );
}

function normalizeOwners(owners: string[]): string[] {
    if (!Array.isArray(owners) || owners.length > 50) {
        throw new Error("INVALID_SHARE_OWNERS");
    }

    if (
        owners.some(
            (value) => typeof value !== "string" || value.trim().length === 0,
        )
    ) {
        throw new Error("INVALID_SHARE_OWNERS");
    }

    return [...new Set(owners)];
}

function validateRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error("INVALID_REVISION");
    }
}

function validateCoordinates(
    latitude: number,
    longitude: number,
    accuracy: number | null,
): void {
    if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180 ||
        (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0))
    ) {
        throw new Error("INVALID_COORDINATES");
    }
}

export async function readLive(userId: string) {
    const result = await db.send(
        new GetCommand({
            TableName: liveTable(),
            Key: { id: liveId(userId) },
            ConsistentRead: true,
        }),
    );

    return result.Item ?? null;
}

export async function readShareState(userId: string) {
    const item = await readLive(userId);

    // 旧形式レコードは未移行として扱う。
    if (
        item &&
        (!Number.isSafeInteger(item.shareRevision) ||
            typeof item.shareEnabled !== "boolean")
    ) {
        throw new Error("LIVE_LOCATION_MIGRATION_REQUIRED");
    }

    return {
        revision: item?.shareRevision ?? 0,
        enabled: item?.shareEnabled === true,
        sharedOwners: Array.isArray(item?.sharedOwners)
            ? (item.sharedOwners as string[])
            : [],
    };
}

type DbItem = Record<string, any>;

async function scanAll(
    table: string,
    filter?: string,
    values?: Record<string, unknown>,
): Promise<DbItem[]> {
    const items: DbItem[] = [];
    let lastKey: Record<string, any> | undefined;

    do {
        const result = await db.send(
            new ScanCommand({
                TableName: table,
                ...(filter
                    ? {
                          FilterExpression: filter,
                          ExpressionAttributeValues: values,
                      }
                    : {}),
                ExclusiveStartKey: lastKey,
                ConsistentRead: true,
            }),
        );

        items.push(...(result.Items ?? []));
        lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return items;
}

/**
 * 共有先が本人と同じ有効なShareGroupに
 * 所属していることを確認する。
 */
export async function validateSharedOwners(
    userId: string,
    requested: string[],
): Promise<string[]> {
    const owners = normalizeOwners(requested);

    if (owners.length === 0) {
        return [];
    }

    const myMemberships = await scanAll(memberTable(), "userId = :userId", {
        ":userId": userId,
    });

    const myGroupIds = [
        ...new Set(
            myMemberships
                .map((member) => member.groupId)
                .filter((value): value is string => typeof value === "string"),
        ),
    ];

    const activeGroupIds = new Set<string>();

    for (const groupId of myGroupIds) {
        const group = await db.send(
            new GetCommand({
                TableName: groupTable(),
                Key: { groupId },
                ConsistentRead: true,
            }),
        );

        if (group.Item?.isActive === true) {
            activeGroupIds.add(groupId);
        }
    }

    if (activeGroupIds.size === 0) {
        throw new Error("NO_ACTIVE_SHARE_GROUP");
    }

    const allMembers = await scanAll(memberTable());

    const allowedOwners = new Set(
        allMembers
            .filter(
                (member) =>
                    activeGroupIds.has(member.groupId) &&
                    member.userId !== userId &&
                    typeof member.ownerValue === "string",
            )
            .map((member) => member.ownerValue as string),
    );

    if (owners.some((owner) => !allowedOwners.has(owner))) {
        throw new Error("SHARE_RECIPIENT_NOT_ALLOWED");
    }

    return owners;
}

type ChangeSharingInput = {
    userId: string;
    owner: string;
    expectedRevision: number;
    sharedOwners: string[];
};

/**
 * 初回共有・共有先変更・共有停止・共有再開。
 *
 * 共有操作だけがshareRevisionとsharedOwnersを変更する。
 */
export async function changeSharing({
    userId,
    owner,
    expectedRevision,
    sharedOwners,
}: ChangeSharingInput): Promise<number> {
    validateRevision(expectedRevision);

    const owners = await validateSharedOwners(userId, sharedOwners);

    const enabled = owners.length > 0;
    const nextRevision = expectedRevision + 1;
    const id = liveId(userId);
    const now = new Date().toISOString();

    const existing = await readLive(userId);

    if (!existing) {
        // 最初の共有操作、またはレコードがない状態での停止。
        // 停止も永続化することで遅延した初回作成を防止する。
        if (expectedRevision !== 0) {
            throw new Error("SHARE_REVISION_CONFLICT");
        }

        try {
            await db.send(
                new PutCommand({
                    TableName: liveTable(),
                    Item: {
                        id,
                        userId,
                        owner,
                        latitude: 0,
                        longitude: 0,
                        accuracy: null,
                        isRecording: false,
                        recordingSessionId: null,
                        updatedAt: now,
                        createdAt: now,
                        __typename: "LiveLocation",

                        // 位置が届くまでは公開しない
                        isActive: false,

                        shareEnabled: enabled,
                        shareRevision: nextRevision,
                        sharedOwners: owners,
                    },
                    ConditionExpression: "attribute_not_exists(id)",
                }),
            );

            return nextRevision;
        } catch (error) {
            if (conditionalFailure(error)) {
                throw new Error("SHARE_REVISION_CONFLICT");
            }
            throw error;
        }
    }

    if (
        !Number.isSafeInteger(existing.shareRevision) ||
        typeof existing.shareEnabled !== "boolean"
    ) {
        throw new Error("LIVE_LOCATION_MIGRATION_REQUIRED");
    }

    if (existing.shareRevision !== expectedRevision) {
        throw new Error("SHARE_REVISION_CONFLICT");
    }

    // 共有継続中の共有先変更は現在地を維持する。
    // 停止・停止後再開では位置を非公開にする。
    const keepActive =
        enabled && existing.shareEnabled === true && existing.isActive === true;

    try {
        await db.send(
            new UpdateCommand({
                TableName: liveTable(),
                Key: { id },

                UpdateExpression: [
                    "SET shareRevision = :next",
                    "shareEnabled = :enabled",
                    "isActive = :active",
                    "sharedOwners = :owners",
                ].join(", "),

                ConditionExpression: [
                    "attribute_exists(id)",
                    "userId = :userId",
                    "shareRevision = :expected",
                ].join(" AND "),

                ExpressionAttributeValues: {
                    ":userId": userId,
                    ":expected": expectedRevision,
                    ":next": nextRevision,
                    ":enabled": enabled,
                    ":active": keepActive,
                    ":owners": owners,
                },
            }),
        );

        return nextRevision;
    } catch (error) {
        if (conditionalFailure(error)) {
            throw new Error("SHARE_REVISION_CONFLICT");
        }
        throw error;
    }
}

type CoordinateInput = {
    userId: string;
    expectedRevision: number;
    latitude: number;
    longitude: number;
    accuracy: number | null;
};

/**
 * 位置情報専用更新。
 *
 * - 共有設定・共有先は変更しない
 * - 現在の世代と一致しない位置更新を拒否
 * - 停止済み共有の再開を禁止
 * - 固定IDが未作成なら拒否
 */
export async function updateCoordinates(input: CoordinateInput): Promise<void> {
    validateRevision(input.expectedRevision);

    validateCoordinates(input.latitude, input.longitude, input.accuracy);

    const now = new Date().toISOString();

    try {
        await db.send(
            new UpdateCommand({
                TableName: liveTable(),
                Key: { id: liveId(input.userId) },

                UpdateExpression: [
                    "SET latitude = :latitude",
                    "longitude = :longitude",
                    "accuracy = :accuracy",
                    "updatedAt = :now",
                    "isActive = :true",
                ].join(", "),

                ConditionExpression: [
                    "attribute_exists(id)",
                    "userId = :userId",
                    "shareRevision = :revision",
                    "shareEnabled = :true",
                    "updatedAt <= :now",
                ].join(" AND "),

                ExpressionAttributeValues: {
                    ":userId": input.userId,
                    ":revision": input.expectedRevision,
                    ":true": true,
                    ":latitude": input.latitude,
                    ":longitude": input.longitude,
                    ":accuracy": input.accuracy,
                    ":now": now,
                },
            }),
        );
    } catch (error) {
        if (conditionalFailure(error)) {
            throw new Error("SHARE_UPDATE_REJECTED");
        }
        throw error;
    }
}

export async function stopLiveLocationRecording({
    userId,
    expectedRevision,
    expectedRecordingSessionId,
}: {
    userId: string;
    expectedRevision: number;
    expectedRecordingSessionId: string;
}): Promise<boolean> {
    if (
        !userId ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 ||
        !expectedRecordingSessionId
    ) {
        throw new Error("INVALID_STOP_LIVE_LOCATION_ARGUMENTS");
    }

    const tableName = process.env.LIVE_LOCATION_TABLE_NAME;

    if (!tableName) {
        throw new Error("LIVE_LOCATION_TABLE_NAME_NOT_SET");
    }

    const id = `live-${userId}`;

    /*
     * 共有世代とRecordingSessionが一致する場合だけ
     * 自動記録状態を終了する。
     *
     * 共有先・共有世代には一切触れない。
     */
    try {
        await db.send(
            new UpdateCommand({
                TableName: tableName,
                Key: { id },

                UpdateExpression:
                    "SET isRecording = :false, " +
                    "recordingSessionId = :null, " +
                    "lastStoppedRecordingSessionId = :sessionId",

                ConditionExpression:
                    "attribute_exists(id) " +
                    "AND userId = :userId " +
                    "AND shareRevision = :revision " +
                    "AND shareEnabled = :true " +
                    "AND isRecording = :true " +
                    "AND recordingSessionId = :sessionId",

                ExpressionAttributeValues: {
                    ":userId": userId,
                    ":revision": expectedRevision,
                    ":true": true,
                    ":false": false,
                    ":sessionId": expectedRecordingSessionId,
                    ":null": null,
                },
            }),
        );

        return true;
    } catch (error) {
        /*
         * 条件付き更新に失敗した場合は、
         * すでに同じ世代で記録停止済みかを確認する。
         */
        if (
            !(error instanceof Error) ||
            error.name !== "ConditionalCheckFailedException"
        ) {
            throw error;
        }

        const result = await db.send(
            new GetCommand({
                TableName: tableName,
                Key: { id },
                ConsistentRead: true,
            }),
        );

        const item = result.Item;

        /*
         * 同じ共有世代で既に記録停止済みの場合だけ
         * 冪等な成功とみなす。
         */
        if (
            item &&
            item.userId === userId &&
            item.shareRevision === expectedRevision &&
            item.shareEnabled === true &&
            item.isRecording === false &&
            item.recordingSessionId == null &&
            item.lastStoppedRecordingSessionId === expectedRecordingSessionId
        ) {
            return true;
        }

        throw new Error("LIVE_LOCATION_RECORDING_STOP_CONFLICT");
    }
}

export async function startLiveLocationRecording({
    userId,
    expectedRevision,
    recordingSessionId,
}: {
    userId: string;
    expectedRevision: number;
    recordingSessionId: string;
}): Promise<boolean> {
    if (
        !userId ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 ||
        !recordingSessionId
    ) {
        throw new Error("INVALID_START_LIVE_LOCATION_ARGUMENTS");
    }

    const tableName = process.env.LIVE_LOCATION_TABLE_NAME;

    if (!tableName) {
        throw new Error("LIVE_LOCATION_TABLE_NAME_NOT_SET");
    }

    const id = `live-${userId}`;

    try {
        await db.send(
            new UpdateCommand({
                TableName: tableName,
                Key: { id },

                UpdateExpression:
                    "SET isRecording = :true, " +
                    "recordingSessionId = :sessionId",

                ConditionExpression:
                    "attribute_exists(id) " +
                    "AND userId = :userId " +
                    "AND shareRevision = :revision " +
                    "AND shareEnabled = :true " +
                    "AND (" +
                    "attribute_not_exists(lastStoppedRecordingSessionId) " +
                    "OR lastStoppedRecordingSessionId <> :sessionId" +
                    ") " +
                    "AND (" +
                    "attribute_not_exists(isRecording) " +
                    "OR isRecording = :false " +
                    "OR (isRecording = :true " +
                    "AND recordingSessionId = :sessionId)" +
                    ")",

                ExpressionAttributeValues: {
                    ":userId": userId,
                    ":revision": expectedRevision,
                    ":true": true,
                    ":false": false,
                    ":sessionId": recordingSessionId,
                },
            }),
        );

        return true;
    } catch (error) {
        if (
            error instanceof Error &&
            error.name === "ConditionalCheckFailedException"
        ) {
            throw new Error("LIVE_LOCATION_RECORDING_START_CONFLICT");
        }

        throw error;
    }
}
