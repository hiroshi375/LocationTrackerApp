import type { SubscriptionTier } from "../config/subscriptionPlan";

/*
 * RevenueCatで使用するEntitlement ID。
 *
 * Phase 1ではRevenueCat未接続だが、
 * 今後このIDでPremium判定を行う。
 */
export const PREMIUM_ENTITLEMENT_ID = "premium";

/*
 * Phase 1:
 * まだRevenueCatへ接続していないため、
 * すべてのユーザーをFREEとして扱う。
 *
 * Phase 5でRevenueCatのCustomerInfoから
 * FREE / PREMIUMを判定するように差し替える。
 */
export async function getCurrentSubscriptionTier(): Promise<SubscriptionTier> {
    return "FREE";
}
