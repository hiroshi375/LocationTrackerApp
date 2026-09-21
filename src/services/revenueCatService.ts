import Purchases, {
    LOG_LEVEL,
    type CustomerInfo,
} from "react-native-purchases";

export const PREMIUM_ENTITLEMENT_ID = "premium";
export const PREMIUM_PACKAGE_ID = "lifetime_premium";
export const PREMIUM_PRODUCT_ID = "premium_lifetime";

const REVENUECAT_TEST_API_KEY =
    process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY ?? "";

let revenueCatConfigured = false;

export function configureRevenueCat(): void {
    if (revenueCatConfigured) {
        return;
    }

    if (!REVENUECAT_TEST_API_KEY) {
        throw new Error(
            "EXPO_PUBLIC_REVENUECAT_TEST_API_KEY is not configured.",
        );
    }

    Purchases.setLogLevel(LOG_LEVEL.DEBUG);

    /*
     * まず匿名状態でSDKを1回だけ初期化する。
     *
     * Cognitoログイン後にPurchases.logIn(userId)を呼び、
     * RevenueCatのApp User IDとCognito userIdを紐付ける。
     */
    Purchases.configure({
        apiKey: REVENUECAT_TEST_API_KEY,
    });

    revenueCatConfigured = true;

    console.log("[RevenueCat] configured");
}

/**
 * Cognito userIdをRevenueCat App User IDとして使用する。
 */
export async function identifyRevenueCatUser(
    userId: string,
): Promise<CustomerInfo> {
    configureRevenueCat();

    const normalizedUserId = userId.trim();

    if (!normalizedUserId) {
        throw new Error("RevenueCat userId is empty.");
    }

    const result = await Purchases.logIn(normalizedUserId);

    console.log("[RevenueCat] user identified:", {
        userId: normalizedUserId,
        created: result.created,
    });

    return result.customerInfo;
}

/**
 * RevenueCat側のログインユーザーを解除する。
 *
 * logOut後はRevenueCat SDKが新しい匿名App User IDを生成する。
 */
export async function logoutRevenueCatUser(): Promise<void> {
    if (!revenueCatConfigured) {
        return;
    }

    try {
        await Purchases.logOut();

        console.log("[RevenueCat] user logged out");
    } catch (error) {
        console.error("[RevenueCat] logOut error:", error);
    }
}

export async function getRevenueCatCustomerInfo(): Promise<CustomerInfo> {
    configureRevenueCat();

    return Purchases.getCustomerInfo();
}

export function hasPremiumEntitlement(customerInfo: CustomerInfo): boolean {
    return Boolean(customerInfo.entitlements.active[PREMIUM_ENTITLEMENT_ID]);
}
