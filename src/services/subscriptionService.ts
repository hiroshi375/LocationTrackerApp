import type { SubscriptionTier } from "../config/subscriptionPlan";
import { getCurrentUserProfile } from "./userProfileService";

/*
 * RevenueCatで使用するEntitlement ID。
 */
export const PREMIUM_ENTITLEMENT_ID = "premium";

export async function getCurrentSubscriptionTier(): Promise<SubscriptionTier> {
    /*
     * 管理者は課金状態に関係なく
     * Premium相当の機能を利用可能とする。
     */
    const profile = await getCurrentUserProfile();

    if (profile.role === "admin") {
        console.log("[Subscription] Admin user -> PREMIUM");
        return "PREMIUM";
    }

    /*
     * 現時点ではRevenueCat未接続のため、
     * 一般ユーザーはFREEとして扱う。
     *
     * Phase 5でRevenueCat判定へ置き換える。
     */
    return "FREE";
}
