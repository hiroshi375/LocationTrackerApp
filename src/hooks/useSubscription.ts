import { useCallback, useEffect, useState } from "react";
import Purchases from "react-native-purchases";

import type { SubscriptionTier } from "../config/subscriptionPlan";
import { getCurrentSubscriptionTier } from "../services/subscriptionService";

export function useSubscription() {
    const [tier, setTier] = useState<SubscriptionTier>("FREE");
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setLoading(true);

            const nextTier = await getCurrentSubscriptionTier();

            setTier(nextTier);
        } catch (error) {
            console.error("[Subscription] load error:", error);

            /*
             * 課金状態を取得できない場合は、
             * Premium機能を誤って開放しないようFREE扱いにする。
             */
            setTier("FREE");
        } finally {
            setLoading(false);
        }
    }, []);

    /*
     * 初回表示時に現在のPremium状態を取得する。
     */
    useEffect(() => {
        void refresh();
    }, [refresh]);

    /*
     * RevenueCatのCustomerInfoが更新された場合、
     * FREE / PREMIUM判定を再取得する。
     *
     * purchasePackage()
     * restorePurchases()
     * getCustomerInfo()
     * などでCustomerInfoが更新された際に呼ばれる。
     */
    useEffect(() => {
        const handleCustomerInfoUpdated = () => {
            console.log("[Subscription] CustomerInfo updated -> refresh");

            void refresh();
        };

        Purchases.addCustomerInfoUpdateListener(handleCustomerInfoUpdated);

        return () => {
            Purchases.removeCustomerInfoUpdateListener(
                handleCustomerInfoUpdated,
            );
        };
    }, [refresh]);

    return {
        tier,
        isPremium: tier === "PREMIUM",
        loading,
        refresh,
    };
}
