import type { SubscriptionTier } from "../config/subscriptionPlan";
import {
    getRevenueCatCustomerInfo,
    hasPremiumEntitlement,
    isRevenueCatEnabled,
} from "./revenueCatService";
import { getCurrentUserProfile } from "./userProfileService";

/*
 * RevenueCatで使用するEntitlement ID。
 *
 * revenueCatService.ts側でも "premium" を使用しているため、
 * 判定はhasPremiumEntitlement()へ集約する。
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

    if (!isRevenueCatEnabled()) {
        console.log("[Subscription] RevenueCat disabled -> FREE");

        return "FREE";
    }

    /*
     * 一般ユーザーはRevenueCatの
     * premium EntitlementでPremium判定する。
     */
    try {
        const customerInfo = await getRevenueCatCustomerInfo();

        const isPremium = hasPremiumEntitlement(customerInfo);

        console.log("[Subscription] RevenueCat tier:", {
            isPremium,
            activeEntitlements: Object.keys(customerInfo.entitlements.active),
        });

        return isPremium ? "PREMIUM" : "FREE";
    } catch (error) {
        /*
         * RevenueCatへ接続できない場合、
         * 誤ってPremium機能を開放しない。
         *
         * useSubscription側でもcatchしてFREEにするが、
         * service単体で使われても安全なようにFREEへ倒す。
         */
        console.error("[Subscription] RevenueCat check error:", error);

        return "FREE";
    }
}
