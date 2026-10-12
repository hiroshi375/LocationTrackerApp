/**
 * historicalShareLegacyMigration.ts
 *
 * 旧方式の共有先をGrantへ移行できるか判定する。
 *
 * この関数は読み取りデータのみを扱い、
 * DynamoDBへの書き込みは行わない。
 */

export type LegacyShareRecord = {
    id: string;
    sharedOwners?: readonly (string | null)[] | null;
};

export type LegacyShareGroup = {
    groupId: string;
    memberUserIds: readonly string[];
};

export type LegacyShareTarget = {
    groupId: string;
    recipientUserId: string;
};

export type LegacyMigrationPlan = {
    recordingSessionRecordId: string;
    recipients: string[];
    targets: LegacyShareTarget[];
    locationLogCount: number;
};

const normalizeOwners = (
    values: readonly (string | null)[] | null | undefined,
): string[] => {
    return Array.from(
        new Set(
            (values ?? []).filter(
                (value): value is string =>
                    typeof value === "string" && value.length > 0,
            ),
        ),
    ).sort();
};

const sameStrings = (
    left: readonly string[],
    right: readonly string[],
): boolean => {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
};

/**
 * @throws 安全に移行できない場合
 */
export const buildLegacyMigrationPlan = (params: {
    session: LegacyShareRecord;
    locationLogs: readonly LegacyShareRecord[];
    groups: readonly LegacyShareGroup[];
    ownerUserId: string;
    expectedLocationLogCount?: number;
}): LegacyMigrationPlan => {
    const {
        session,
        locationLogs,
        groups,
        ownerUserId,
        expectedLocationLogCount,
    } = params;

    const recipients = normalizeOwners(session.sharedOwners).filter(
        (userId) => userId !== ownerUserId,
    );

    // 読み取り途中で欠落したデータを移行しない
    if (
        expectedLocationLogCount !== undefined &&
        locationLogs.length !== expectedLocationLogCount
    ) {
        throw new Error(
            `LocationLog件数が一致しません: ` +
                `${locationLogs.length}/${expectedLocationLogCount}`,
        );
    }

    const seenIds = new Set<string>();

    for (const log of locationLogs) {
        if (seenIds.has(log.id)) {
            throw new Error(`LocationLogが重複しています: ${log.id}`);
        }

        seenIds.add(log.id);

        const owners = normalizeOwners(log.sharedOwners).filter(
            (userId) => userId !== ownerUserId,
        );

        if (!sameStrings(recipients, owners)) {
            throw new Error(`LocationLogの共有先が一致しません: ${log.id}`);
        }
    }

    const targets: LegacyShareTarget[] = [];

    for (const recipientUserId of recipients) {
        // グループ名ではなくIDで判断する
        const matchingGroups = groups.filter(
            (group) =>
                group.memberUserIds.includes(ownerUserId) &&
                group.memberUserIds.includes(recipientUserId),
        );

        const uniqueGroupIds = Array.from(
            new Set(matchingGroups.map((group) => group.groupId)),
        );

        if (uniqueGroupIds.length !== 1) {
            throw new Error(
                `共有先 ${recipientUserId} のグループを` +
                    `一意に特定できません。` +
                    `候補数=${uniqueGroupIds.length}`,
            );
        }

        targets.push({
            groupId: uniqueGroupIds[0],
            recipientUserId,
        });
    }

    return {
        recordingSessionRecordId: session.id,
        recipients,
        targets,
        locationLogCount: locationLogs.length,
    };
};
