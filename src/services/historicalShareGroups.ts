export type HistoricalShareGroup = {
    groupId: string;
    name: string;
    lifecycle?: string | null;
    members: { userId: string }[];
};

/** Only return explicitly shared memberships without an active grant for this recipient. */
export function getUnsharedHistoricalGroups(
    groups: HistoricalShareGroup[],
    grants: { groupId: string; recipientUserId: string; isActive: boolean }[],
    recipientUserId: string,
): HistoricalShareGroup[] {
    const active = new Set(grants.filter(g => g.isActive && g.recipientUserId === recipientUserId).map(g => g.groupId));
    return Array.from(new Map(groups
        .filter(group => group.groupId && (!group.lifecycle || group.lifecycle === "ACTIVE") && Array.isArray(group.members) && group.members.some(member => member?.userId === recipientUserId) && !active.has(group.groupId))
        .map(group => [group.groupId, group])).values());
}
