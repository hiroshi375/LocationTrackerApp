import { fencedWrite, tables } from "./groupAccessStore";
import type { HistoricalShareOperation } from "./historicalShareOperation";

/** Recovery is admitted by the same group lock as normal writes. */
export async function prepareStoppedHistoricalRecovery(previous: HistoricalShareOperation, caller: string, args: any) {
    const sameIntent = previous.ownerUserId === caller && previous.groupId === args.groupId &&
        previous.recipientUserId === args.recipientUserId && previous.requestedEnabled === args.enabled;
    if (!sameIntent || previous.grantManaged !== true || previous.operationPhase !== "GRANT_WRITE_CONFIRMED" || !previous.grantWriteConfirmedAt) {
        throw new Error("未完了の共有操作があります。元の共有先・グループ・操作で再実行してください。未確定の操作は個別診断が必要です。");
    }
    // Lambda hard limit is 30 seconds. Wait 90 seconds beyond its last durable
    // write, and retain CAS + new operation ID + group fencing on every update.
    const age = Date.now() - Date.parse(previous.updatedAt);
    if (!Number.isFinite(age) || age < 90000) throw new Error("共有操作が実行中の可能性があります。90秒以上待って再実行してください。");
    if (previous.status === "FAILED") return;
    if (previous.status !== "PENDING" && previous.status !== "APPLYING") throw new Error("復旧できない操作状態です。");
    await fencedWrite([{ Update: {
        TableName: tables.operations(), Key: { recordingSessionRecordId: previous.recordingSessionRecordId },
        UpdateExpression: "SET #s = :failed, errorMessage = :message",
        ConditionExpression: "operationId = :op AND ownerUserId = :owner AND #s = :before AND updatedAt = :updated AND operationPhase = :phase",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":failed": "FAILED", ":message": "Expired execution admitted for fenced recovery", ":op": previous.operationId,
            ":owner": caller, ":before": previous.status, ":updated": previous.updatedAt, ":phase": "GRANT_WRITE_CONFIRMED" },
    } }]);
}
