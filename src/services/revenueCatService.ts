import Purchases, {
    LOG_LEVEL,
    PURCHASES_ERROR_CODE,
    type CustomerInfo,
    type PurchasesPackage,
} from "react-native-purchases";

export const PREMIUM_ENTITLEMENT_ID = "premium";
export const PREMIUM_PACKAGE_ID = "lifetime_premium";
export const PREMIUM_PRODUCT_ID = "premium_lifetime";

const REVENUECAT_TEST_API_KEY =
    process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY ?? "";

const REVENUECAT_ANDROID_API_KEY =
    process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? "";

const REVENUECAT_API_KEY = __DEV__
    ? REVENUECAT_TEST_API_KEY
    : REVENUECAT_ANDROID_API_KEY;

let revenueCatConfigured = false;

const REVENUECAT_ENABLED =
    process.env.EXPO_PUBLIC_REVENUECAT_ENABLED !== "false";

export function isRevenueCatEnabled(): boolean {
    return REVENUECAT_ENABLED;
}

export async function configureRevenueCat(): Promise<void> {
    if (!REVENUECAT_ENABLED) {
        console.log(
            "[RevenueCat] Disabled by EXPO_PUBLIC_REVENUECAT_ENABLED=false",
        );
        return;
    }

    if (revenueCatConfigured) {
        return;
    }

    if (!REVENUECAT_API_KEY) {
        throw new Error(
            __DEV__
                ? "EXPO_PUBLIC_REVENUECAT_TEST_API_KEY is not configured."
                : "EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY is not configured.",
        );
    }

    Purchases.setLogLevel(LOG_LEVEL.DEBUG);

    Purchases.configure({
        apiKey: REVENUECAT_API_KEY,
    });

    revenueCatConfigured = true;

    console.log("[RevenueCat] configured:", {
        environment: __DEV__ ? "development" : "production",
        keyType: __DEV__ ? "test" : "android-production",
    });
}

export async function identifyRevenueCatUser(
    userId: string,
): Promise<CustomerInfo> {
    if (!REVENUECAT_ENABLED) {
        console.log(
            "[RevenueCat] identify skipped because RevenueCat is disabled",
        );

        throw new Error("RevenueCat is disabled.");
    }

    await configureRevenueCat();

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

export async function logoutRevenueCatUser(): Promise<void> {
    if (!revenueCatConfigured) {
        return;
    }

    try {
        const isAnonymous = await Purchases.isAnonymous();

        if (isAnonymous) {
            console.log(
                "[RevenueCat] logOut skipped: current user is already anonymous",
            );

            return;
        }

        await Purchases.logOut();

        console.log("[RevenueCat] user logged out");
    } catch (error) {
        console.error("[RevenueCat] logOut error:", error);
    }
}

export async function getRevenueCatCustomerInfo(): Promise<CustomerInfo> {
    if (!REVENUECAT_ENABLED) {
        console.log(
            "[RevenueCat] getCustomerInfo skipped because RevenueCat is disabled",
        );

        throw new Error("RevenueCat is disabled.");
    }

    await configureRevenueCat();

    return Purchases.getCustomerInfo();
}

export function hasPremiumEntitlement(customerInfo: CustomerInfo): boolean {
    return Boolean(customerInfo.entitlements.active[PREMIUM_ENTITLEMENT_ID]);
}

/**
 * RevenueCatのdefault Offeringから
 * lifetime_premium Packageを取得する。
 */
export async function getPremiumPackage(): Promise<PurchasesPackage | null> {
    if (!REVENUECAT_ENABLED) {
        console.log(
            "[RevenueCat] getPremiumPackage skipped because RevenueCat is disabled",
        );

        return null;
    }

    await configureRevenueCat();

    const offerings = await Purchases.getOfferings();

    console.log("[RevenueCat] offerings loaded:", {
        currentOfferingId: offerings.current?.identifier ?? null,
        packages:
            offerings.current?.availablePackages.map((item) => ({
                identifier: item.identifier,
                productIdentifier: item.product.identifier,
                priceString: item.product.priceString,
            })) ?? [],
    });

    if (!offerings.current) {
        return null;
    }

    return (
        offerings.current.availablePackages.find(
            (item) =>
                item.identifier === PREMIUM_PACKAGE_ID ||
                item.product.identifier === PREMIUM_PRODUCT_ID,
        ) ?? null
    );
}

export type PremiumPurchaseResult =
    | {
          status: "PURCHASED";
          customerInfo: CustomerInfo;
      }
    | {
          status: "CANCELLED";
      };

/**
 * Premium買い切り商品の購入。
 */
export async function purchasePremium(): Promise<PremiumPurchaseResult> {
    if (!REVENUECAT_ENABLED) {
        throw new Error("Premium購入機能は現在一時的に停止しています。");
    }

    await configureRevenueCat();

    const premiumPackage = await getPremiumPackage();

    if (!premiumPackage) {
        throw new Error(
            "Premium商品をRevenueCat Offeringから取得できませんでした。",
        );
    }

    try {
        console.log("[RevenueCat] purchase start:", {
            packageIdentifier: premiumPackage.identifier,
            productIdentifier: premiumPackage.product.identifier,
            priceString: premiumPackage.product.priceString,
        });

        const { customerInfo } =
            await Purchases.purchasePackage(premiumPackage);

        const premiumActive = hasPremiumEntitlement(customerInfo);

        console.log("[RevenueCat] purchase completed:", {
            premiumActive,
        });

        if (!premiumActive) {
            throw new Error(
                "購入は完了しましたが、Premium権限を確認できませんでした。",
            );
        }

        return {
            status: "PURCHASED",
            customerInfo,
        };
    } catch (error: any) {
        if (error?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) {
            console.log("[RevenueCat] purchase cancelled");

            return {
                status: "CANCELLED",
            };
        }

        console.error("[RevenueCat] purchase error:", error);

        throw error;
    }
}

/**
 * 既存購入の復元。
 */
export async function restorePremiumPurchases(): Promise<CustomerInfo> {
    if (!REVENUECAT_ENABLED) {
        throw new Error("購入の復元機能は現在一時的に停止しています。");
    }

    await configureRevenueCat();

    const customerInfo = await Purchases.restorePurchases();

    console.log("[RevenueCat] purchases restored:", {
        premiumActive: hasPremiumEntitlement(customerInfo),
    });

    return customerInfo;
}
