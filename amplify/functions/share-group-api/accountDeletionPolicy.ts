export type DeletionRow = Record<string, any>;
export const isAccountOwnerValue = (value: unknown, userId: string) =>
    typeof value === "string" && (value === userId || value.startsWith(`${userId}::`));
export function ownsIndex(row: DeletionRow, userId: string) {
    try { const key = JSON.parse(row.sessionKey); return Array.isArray(key) && key[0] === userId; }
    catch { return false; }
}
export const accountRelated = (row: DeletionRow, userId: string) =>
    row.userId === userId || row.ownerUserId === userId || row.recipientUserId === userId;
export function withoutAccount(owners: unknown, userId: string): string[] {
    return Array.isArray(owners) ? owners.filter(value => !isAccountOwnerValue(value, userId)) : [];
}
