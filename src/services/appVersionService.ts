import { Linking, Platform } from "react-native";
import * as Application from "expo-application";

const APP_VERSION_CONFIG_URL =
    "https://hiroshi375.github.io/LocationTrackerApp/app-version.json";

const DEFAULT_PLAY_STORE_URL =
    "https://play.google.com/store/apps/details?id=com.hiroshisato.locationtrackerapp";

const PLAY_STORE_APP_URL =
    "market://details?id=com.hiroshisato.locationtrackerapp";

const DEFAULT_APP_STORE_URL = "https://apps.apple.com/app/id6818737493";

const APP_STORE_APP_URL = "itms-apps://apps.apple.com/app/id6818737493";

export type AppPlatform = "android" | "ios";

export type PlatformVersionConfig = {
    latestVersion: string;
    latestBuild: number;
    minimumSupportedBuild: number;
    storeUrl?: string | null;
    message?: string | null;
};

export type AppVersionConfig = {
    android: PlatformVersionConfig;
    ios: PlatformVersionConfig;
};

export type AppVersionCheckResult = {
    platform: AppPlatform;

    currentBuild: number | null;
    currentVersion: string | null;

    latestBuild: number;
    latestVersion: string;

    minimumSupportedBuild: number;

    updateAvailable: boolean;
    updateRequired: boolean;

    message: string;
    storeUrl: string;
};

function getCurrentPlatform(): AppPlatform {
    return Platform.OS === "ios" ? "ios" : "android";
}

export async function checkAppVersion(): Promise<AppVersionCheckResult> {
    const response = await fetch(APP_VERSION_CONFIG_URL, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "Cache-Control": "no-cache",
        },
    });

    if (!response.ok) {
        throw new Error(
            `App version config request failed: ${response.status}`,
        );
    }

    const raw = (await response.json()) as Partial<AppVersionConfig>;

    const platform = getCurrentPlatform();

    const platformConfig = platform === "ios" ? raw.ios : raw.android;

    if (!platformConfig) {
        throw new Error(`App version config for ${platform} is missing`);
    }

    const latestBuild = Number(platformConfig.latestBuild);

    const minimumSupportedBuild = Number(
        platformConfig.minimumSupportedBuild ?? 1,
    );

    if (!Number.isFinite(latestBuild) || latestBuild <= 0) {
        throw new Error(
            `Invalid latestBuild for ${platform} in app-version.json`,
        );
    }

    if (!Number.isFinite(minimumSupportedBuild) || minimumSupportedBuild <= 0) {
        throw new Error(
            `Invalid minimumSupportedBuild for ${platform} in app-version.json`,
        );
    }

    const currentBuildValue = Application.nativeBuildVersion;

    const parsedCurrentBuild =
        currentBuildValue !== null && currentBuildValue !== undefined
            ? Number(currentBuildValue)
            : NaN;

    const currentBuild = Number.isFinite(parsedCurrentBuild)
        ? parsedCurrentBuild
        : null;

    const currentVersion = Application.nativeApplicationVersion ?? null;

    const updateAvailable = currentBuild !== null && currentBuild < latestBuild;

    const updateRequired =
        currentBuild !== null && currentBuild < minimumSupportedBuild;

    const defaultStoreUrl =
        platform === "ios" ? DEFAULT_APP_STORE_URL : DEFAULT_PLAY_STORE_URL;

    return {
        platform,

        currentBuild,
        currentVersion,

        latestBuild,

        latestVersion:
            typeof platformConfig.latestVersion === "string"
                ? platformConfig.latestVersion
                : "",

        minimumSupportedBuild,

        updateAvailable,
        updateRequired,

        message:
            typeof platformConfig.message === "string" &&
            platformConfig.message.trim().length > 0
                ? platformConfig.message.trim()
                : "AcLog Fitの新しいバージョンをご利用いただけます。",

        storeUrl:
            typeof platformConfig.storeUrl === "string" &&
            platformConfig.storeUrl.trim().length > 0
                ? platformConfig.storeUrl.trim()
                : defaultStoreUrl,
    };
}

export async function openAppStore(
    webUrl: string = DEFAULT_APP_STORE_URL,
): Promise<void> {
    if (Platform.OS === "ios") {
        try {
            const supported = await Linking.canOpenURL(APP_STORE_APP_URL);

            if (supported) {
                await Linking.openURL(APP_STORE_APP_URL);
                return;
            }
        } catch (error) {
            console.log("[AppVersion] App Store app open skipped:", error);
        }
    }

    await Linking.openURL(webUrl);
}

export async function openGooglePlay(
    webUrl: string = DEFAULT_PLAY_STORE_URL,
): Promise<void> {
    if (Platform.OS === "android") {
        try {
            const supported = await Linking.canOpenURL(PLAY_STORE_APP_URL);

            if (supported) {
                await Linking.openURL(PLAY_STORE_APP_URL);
                return;
            }
        } catch (error) {
            console.log("[AppVersion] Play Store app open skipped:", error);
        }
    }

    await Linking.openURL(webUrl);
}

export async function openCurrentStore(webUrl?: string): Promise<void> {
    if (Platform.OS === "ios") {
        await openAppStore(webUrl);
        return;
    }

    await openGooglePlay(webUrl);
}
