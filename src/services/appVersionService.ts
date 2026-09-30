import { Linking, Platform } from "react-native";
import * as Application from "expo-application";

const APP_VERSION_CONFIG_URL =
    "https://hiroshi375.github.io/LocationTrackerApp/app-version.json";

const DEFAULT_PLAY_STORE_URL =
    "https://play.google.com/store/apps/details?id=com.hiroshisato.locationtrackerapp";

const PLAY_STORE_APP_URL =
    "market://details?id=com.hiroshisato.locationtrackerapp";

export type AppVersionConfig = {
    latestVersion: string;
    latestBuild: number;
    minimumSupportedBuild: number;
    message?: string | null;
    playStoreUrl?: string | null;
};

export type AppVersionCheckResult = {
    currentBuild: number | null;
    currentVersion: string | null;

    latestBuild: number;
    latestVersion: string;

    updateAvailable: boolean;
    updateRequired: boolean;

    message: string;
    playStoreUrl: string;
};

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

    const latestBuild = Number(raw.latestBuild);
    const minimumSupportedBuild = Number(raw.minimumSupportedBuild ?? 1);

    if (!Number.isFinite(latestBuild) || latestBuild <= 0) {
        throw new Error("Invalid latestBuild in app-version.json");
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

    /*
     * 開発環境などでbuild番号が取得できない場合は、
     * 誤って更新案内を出さない。
     */
    const updateAvailable = currentBuild !== null && currentBuild < latestBuild;

    const updateRequired =
        currentBuild !== null && currentBuild < minimumSupportedBuild;

    return {
        currentBuild,
        currentVersion,

        latestBuild,
        latestVersion:
            typeof raw.latestVersion === "string" ? raw.latestVersion : "",

        updateAvailable,
        updateRequired,

        message:
            typeof raw.message === "string" && raw.message.trim().length > 0
                ? raw.message.trim()
                : "AcLog Fitの新しいバージョンをご利用いただけます。",

        playStoreUrl:
            typeof raw.playStoreUrl === "string" &&
            raw.playStoreUrl.trim().length > 0
                ? raw.playStoreUrl.trim()
                : DEFAULT_PLAY_STORE_URL,
    };
}

export async function openGooglePlay(
    webUrl: string = DEFAULT_PLAY_STORE_URL,
): Promise<void> {
    /*
     * Androidでは可能ならGoogle Playアプリを直接開く。
     */
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

    /*
     * Play Storeアプリを開けない場合はWeb版へ。
     */
    await Linking.openURL(webUrl);
}
