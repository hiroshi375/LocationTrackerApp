import { z } from "zod";
import {
    accessDb,
    tables,
    getRow,
    scanRows,
    projectedOwners,
    type Row,
} from "./groupAccessStore";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { assertRecordOwner } from "./groupAccessOperation";
import { logIndexWrite } from "./sessionLogIndex";

const optionalText = z.string().nullable().optional();
const inputSchema = z.object({
    id: z.string().min(1).max(1024),
    userId: z.string().min(1),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().nullable().optional(),
    recordedAt: z.string().datetime({ offset: true }),
    memo: optionalText,
    recordingSessionId: optionalText,
    recordingSessionName: optionalText,
    source: optionalText,
    locationUniqueKey: optionalText,
    batteryLevel: z.number().finite().nullable().optional(),
    batteryState: optionalText,
    lowPowerMode: z.boolean().nullable().optional(),
    activityType: optionalText,
    isAggregationTarget: z.boolean().nullable().optional(),
});
export function parseLocationInput(input: unknown, userId: string) {
    const parsed = inputSchema.parse(
        typeof input === "string" ? JSON.parse(input) : input,
    );
    if (parsed.userId !== userId)
        throw new Error("位置情報の所有者が一致しません。");
    return parsed; // sharedOwners, owner, timestamps are deliberately stripped.
}
export async function ingestLocationLog(
    userId: string,
    username: string,
    input: unknown,
) {
    const parsed = parseLocationInput(input, userId);
    const existing = await getRow(tables.logs(), { id: parsed.id });
    if (existing) {
        assertRecordOwner(existing, userId);
        if (
            existing.recordingSessionId !== parsed.recordingSessionId ||
            existing.recordedAt !== parsed.recordedAt ||
            existing.latitude !== parsed.latitude ||
            existing.longitude !== parsed.longitude
        )
            throw new Error("位置情報IDが別の記録と衝突しています。");
        return { id: parsed.id, created: false };
    }
    let session: Row | undefined;
    if (parsed.recordingSessionId) {
        session = await getRow(tables.sessions(), {
            id: `recording-session:${userId}:${parsed.recordingSessionId}`,
        });
        if (!session) {
            const matches = await scanRows(
                tables.sessions(),
                (row) =>
                    row.userId === userId &&
                    row.recordingSessionId === parsed.recordingSessionId,
            );
            if (matches.length > 1)
                throw new Error("履歴のセッションIDが重複しています。");
            session = matches[0];
        }
    }
    if (session) assertRecordOwner(session, userId);
    const sessionRecordId =
        session?.id ??
        `recording-session:${userId}:${parsed.recordingSessionId ?? "__unassigned__"}`;
    const operation = await getRow(tables.operations(), {
        recordingSessionRecordId: sessionRecordId,
    });
    if (operation && operation.status !== "COMPLETED")
        throw new Error(
            "共有権限の更新中です。位置情報を保存してから再送してください。",
        );
    const grants =
        operation?.grantManaged === true
            ? await scanRows(
                  tables.grants(),
                  (row) => row.recordingSessionRecordId === sessionRecordId,
              )
            : [];
    const sharedOwners = projectedOwners(grants, sessionRecordId);
    const timestamp = new Date().toISOString();
    await accessDb.send(
        new TransactWriteCommand({
            TransactItems: [
                ...[logIndexWrite(parsed)].filter((write): write is NonNullable<typeof write> => !!write),
                {
                    ConditionCheck: {
                        TableName: tables.operations(),
                        Key: { recordingSessionRecordId: sessionRecordId },
                        ConditionExpression: operation
                            ? "operationId = :id AND #status = :done"
                            : "attribute_not_exists(recordingSessionRecordId)",
                        ...(operation
                            ? {
                                  ExpressionAttributeNames: {
                                      "#status": "status",
                                  },
                                  ExpressionAttributeValues: {
                                      ":id": operation.operationId,
                                      ":done": "COMPLETED",
                                  },
                              }
                            : {}),
                    },
                },
                {
                    Put: {
                        TableName: tables.logs(),
                        Item: {
                            ...parsed,
                            owner: username ? `${userId}::${username}` : userId,
                            sharedOwners,
                            createdAt: timestamp,
                            updatedAt: timestamp,
                            __typename: "LocationLog",
                        },
                        ConditionExpression: "attribute_not_exists(id)",
                    },
                },
            ],
        }),
    );
    return { id: parsed.id, created: true };
}
