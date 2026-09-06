export type SubscriptionTier = "FREE" | "PREMIUM";

export type SubscriptionPlanLimits = {
    /*
     * 月間アクティビティ数。
     * null は上限なし。
     */
    maxMonthlyActivities: number | null;

    /*
     * 1アクティビティの最大記録時間。
     * null は上限なし。
     */
    maxActivityDurationMs: number | null;

    /*
     * 1アクティビティの最大LocationLog件数。
     * null は上限なし。
     */
    maxPointsPerActivity: number | null;

    /*
     * 設定可能な最短記録間隔。
     */
    minRecordingIntervalMs: number;

    /*
     * 設定可能な最小移動距離。
     */
    minRecordingDistanceMeters: number;

    /*
     * 自分が所有できる共有グループ数。
     * null は上限なし。
     */
    maxOwnedShareGroups: number | null;

    /*
     * 1グループに所属できる最大人数。
     * ownerを含む人数。
     * null は上限なし。
     */
    maxUsersPerShareGroup: number | null;
};

export const FREE_PLAN_LIMITS: SubscriptionPlanLimits = {
    maxMonthlyActivities: 30,

    // 2時間
    //maxActivityDurationMs: 2 * 60 * 60 * 1000,
    // 2分(短縮版)
    maxActivityDurationMs: 2 * 60 * 1000,

    maxPointsPerActivity: 1000,

    // 30秒
    minRecordingIntervalMs: 30 * 1000,

    // 50m
    minRecordingDistanceMeters: 50,

    maxOwnedShareGroups: 2,

    // ownerを含めて5人
    maxUsersPerShareGroup: 5,
};

export const PREMIUM_PLAN_LIMITS: SubscriptionPlanLimits = {
    /*
     * Premium側は今後拡充する。
     * 現時点では主要なFree制限を解除する。
     */
    maxMonthlyActivities: null,
    maxActivityDurationMs: null,
    maxPointsPerActivity: null,

    // Premiumでは10秒まで
    minRecordingIntervalMs: 10 * 1000,

    // Premiumでは10mまで
    minRecordingDistanceMeters: 10,

    /*
     * 将来的に変更可能。
     * 完全無制限にはせず、当面は十分大きな上限とする。
     */
    maxOwnedShareGroups: 10,
    maxUsersPerShareGroup: 20,
};

export function getSubscriptionPlanLimits(
    tier: SubscriptionTier,
): SubscriptionPlanLimits {
    return tier === "PREMIUM" ? PREMIUM_PLAN_LIMITS : FREE_PLAN_LIMITS;
}

/*
 * 指定された記録間隔が現在のプランで利用可能か。
 */
export function isRecordingIntervalAllowed(
    tier: SubscriptionTier,
    intervalMs: number,
): boolean {
    const limits = getSubscriptionPlanLimits(tier);

    return intervalMs >= limits.minRecordingIntervalMs;
}

/*
 * 指定された記録距離が現在のプランで利用可能か。
 */
export function isRecordingDistanceAllowed(
    tier: SubscriptionTier,
    distanceMeters: number,
): boolean {
    const limits = getSubscriptionPlanLimits(tier);

    return distanceMeters >= limits.minRecordingDistanceMeters;
}

/*
 * 過去に保存された設定値が現在のプランでは利用できない場合、
 * 最低限許可される値まで補正する。
 */
export function sanitizeRecordingInterval(
    tier: SubscriptionTier,
    intervalMs: number,
): number {
    const limits = getSubscriptionPlanLimits(tier);

    return Math.max(intervalMs, limits.minRecordingIntervalMs);
}

export function sanitizeRecordingDistance(
    tier: SubscriptionTier,
    distanceMeters: number,
): number {
    const limits = getSubscriptionPlanLimits(tier);

    return Math.max(distanceMeters, limits.minRecordingDistanceMeters);
}

/*
 * 月間アクティビティを新しく開始できるか。
 */
export function canStartMonthlyActivity(
    tier: SubscriptionTier,
    currentMonthActivityCount: number,
): boolean {
    const limit = getSubscriptionPlanLimits(tier).maxMonthlyActivities;

    if (limit === null) {
        return true;
    }

    return currentMonthActivityCount < limit;
}

/*
 * 1アクティビティの最大時間に達したか。
 */
export function hasReachedActivityDurationLimit(
    tier: SubscriptionTier,
    elapsedMs: number,
): boolean {
    const limit = getSubscriptionPlanLimits(tier).maxActivityDurationMs;

    if (limit === null) {
        return false;
    }

    return elapsedMs >= limit;
}

/*
 * 1アクティビティの最大ポイント数に達したか。
 */
export function hasReachedActivityPointLimit(
    tier: SubscriptionTier,
    pointCount: number,
): boolean {
    const limit = getSubscriptionPlanLimits(tier).maxPointsPerActivity;

    if (limit === null) {
        return false;
    }

    return pointCount >= limit;
}

/*
 * 新しい共有グループを作成できるか。
 */
export function canCreateShareGroup(
    tier: SubscriptionTier,
    ownedGroupCount: number,
): boolean {
    const limit = getSubscriptionPlanLimits(tier).maxOwnedShareGroups;

    if (limit === null) {
        return true;
    }

    return ownedGroupCount < limit;
}

/*
 * 共有グループへ新しいメンバーを追加できるか。
 *
 * currentMemberCount はownerを含む現在人数。
 */
export function canAddShareGroupMember(
    tier: SubscriptionTier,
    currentMemberCount: number,
): boolean {
    const limit = getSubscriptionPlanLimits(tier).maxUsersPerShareGroup;

    if (limit === null) {
        return true;
    }

    return currentMemberCount < limit;
}
