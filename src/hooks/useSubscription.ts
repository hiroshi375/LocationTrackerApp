import { useCallback, useEffect, useState } from "react";

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

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return {
        tier,
        isPremium: tier === "PREMIUM",
        loading,
        refresh,
    };
}
