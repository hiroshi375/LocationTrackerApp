import type { Row } from "./groupAccessStore";

export function assertRecordOwner(row: Row, userId: string) {
    if (
        row.userId !== userId ||
        typeof row.owner !== "string" ||
        !(row.owner === userId || row.owner.startsWith(`${userId}::`))
    ) {
        throw new Error("NEEDS_REPAIR: 記録の所有者属性が一致しません。");
    }
}
