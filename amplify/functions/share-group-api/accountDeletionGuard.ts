import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { accessDb } from "./groupAccessStore";
export async function assertAccountNotDeleting(userId: string) {
    const table = process.env.ACCOUNT_DELETION_TABLE_NAME;
    if (!table) return; // Backward-compatible before the infrastructure is deployed.
    const result = await accessDb.send(new GetCommand({TableName: table, Key:{userId}, ConsistentRead:true}));
    if (result.Item) throw new Error("ACCOUNT_DELETING: アカウント削除処理中のため記録・共有を変更できません。");
}
