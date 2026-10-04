import { fetchUserAttributes, getCurrentUser } from "aws-amplify/auth";
import { Platform } from "react-native";
import * as Application from "expo-application";

import { client } from "../lib/client";

type UserProfileRecord = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    ownerValue?: string | null;
    owner?: string | null;
    searchText?: string | null;
    iconImagePath?: string | null;
    role: string | null;
    weightKg?: number | null;
    totalAggregationDistanceMeters?: number | null;
    totalAggregationDurationSeconds?: number | null;
    totalAggregationSessionCount?: number | null;
    currentMonthKey?: string | null;
    currentMonthDistanceMeters?: number | null;
    currentMonthDurationSeconds?: number | null;
    currentMonthSessionCount?: number | null;
    subscriptionUsageMonthKey?: string | null;
    currentMonthRecordedActivityCount?: number | null;
    appVersion?: string | null;
    appBuildVersion?: number | null;
    lastAppOpenedAt?: string | null;
};

type CurrentUserProfile = {
    id: string | null;
    userId: string;
    email: string;
    displayName: string;
    ownerValue: string | null;
    iconImagePath: string | null;
    role: string | null;
    weightKg: number | null;
    totalAggregationDistanceMeters: number;
    totalAggregationDurationSeconds: number;
    totalAggregationSessionCount: number;
    currentMonthKey: string | null;
    currentMonthDistanceMeters: number;
    currentMonthDurationSeconds: number;
    currentMonthSessionCount: number;
    subscriptionUsageMonthKey: string | null;
    currentMonthRecordedActivityCount: number;
    appVersion: string | null;
    appBuildVersion: number | null;
    lastAppOpenedAt: string | null;
};

export async function ensureUserProfile() {
    const user = await getCurrentUser();
    const attributes = await fetchUserAttributes();

    const email = attributes.email ?? user.signInDetails?.loginId ?? "";
    const defaultDisplayName =
        attributes.name ?? email ?? user.username ?? "ユーザー";

    const existing = await findExistingUserProfile(user.userId);

    if (existing) {
        const savedDisplayName = existing.displayName?.trim();

        const nextDisplayName =
            savedDisplayName && savedDisplayName.length > 0
                ? savedDisplayName
                : defaultDisplayName;

        const updateResult = await client.models.UserProfile.update({
            id: existing.id,
            userId: user.userId,
            email,
            displayName: nextDisplayName,
            ownerValue: existing.ownerValue ?? user.userId,
            searchText: buildSearchText(nextDisplayName, email),
        });

        if (updateResult.errors) {
            console.error("UserProfile update errors:", updateResult.errors);
        }

        return;
    }

    const createResult = await client.models.UserProfile.create({
        id: user.userId,
        userId: user.userId,
        email,
        displayName: defaultDisplayName,
        ownerValue: user.userId,
        searchText: buildSearchText(defaultDisplayName, email),
    });

    if (createResult.errors) {
        console.error("UserProfile create errors:", createResult.errors);
    }
}

export async function updateUserProfileDisplayName(displayName: string) {
    const trimmedDisplayName = displayName.trim();

    if (!trimmedDisplayName) {
        throw new Error("ユーザー名が空です。");
    }

    const user = await getCurrentUser();
    const attributes = await fetchUserAttributes();

    const email = attributes.email ?? user.signInDetails?.loginId ?? "";

    const existing = await findExistingUserProfile(user.userId);

    if (existing) {
        const updateResult = await client.models.UserProfile.update({
            id: existing.id,
            userId: user.userId,
            email,
            displayName: trimmedDisplayName,
            ownerValue: existing.ownerValue ?? user.userId,
            searchText: buildSearchText(trimmedDisplayName, email),
        });

        if (updateResult.errors) {
            console.error("UserProfile update errors:", updateResult.errors);
            throw new Error("プロフィールを更新できませんでした。");
        }

        return;
    }

    const createResult = await client.models.UserProfile.create({
        id: user.userId,
        userId: user.userId,
        email,
        displayName: trimmedDisplayName,
        ownerValue: user.userId,
        searchText: buildSearchText(trimmedDisplayName, email),
    });

    if (createResult.errors) {
        console.error("UserProfile create errors:", createResult.errors);
        throw new Error("プロフィールを作成できませんでした。");
    }
}

export async function updateUserProfileWeightKg(weightKg: number | null) {
    const user = await getCurrentUser();

    const existing = await findExistingUserProfile(user.userId);

    if (!existing) {
        throw new Error("プロフィールが見つかりません。");
    }

    const updateResult = await client.models.UserProfile.update({
        id: existing.id,
        weightKg,
    });

    if (updateResult.errors) {
        console.error("UserProfile weight update errors:", updateResult.errors);

        throw new Error("体重を更新できませんでした。");
    }
}

/**
 * 現在ログインしているユーザーの
 * アプリVersion / Build / 最終起動日時をUserProfileへ保存する。
 *
 * ユーザーが現在利用しているアプリのバージョン・ビルド・OS情報を
 * 管理側で確認するために使用する。
 */
export async function updateCurrentUserAppUsage(): Promise<void> {
    const user = await getCurrentUser();

    let existing = await findExistingUserProfile(user.userId);

    /*
     * UserProfileがまだ存在しないユーザーの場合は、
     * 先に通常のプロフィールを作成する。
     */
    if (!existing) {
        await ensureUserProfile();

        existing = await findExistingUserProfile(user.userId);
    }

    if (!existing?.id) {
        throw new Error(
            `UserProfileを取得できませんでした。userId: ${user.userId}`,
        );
    }

    const appVersion = Application.nativeApplicationVersion ?? null;
    const nativeBuildVersion = Application.nativeBuildVersion;

    const parsedBuildVersion =
        nativeBuildVersion !== null && nativeBuildVersion !== undefined
            ? Number(nativeBuildVersion)
            : NaN;

    const appBuildVersion = Number.isFinite(parsedBuildVersion)
        ? Math.trunc(parsedBuildVersion)
        : null;

    const lastAppPlatform = Platform.OS === "ios" ? "ios" : "android";

    const lastAppOpenedAt = new Date().toISOString();

    const updateResult = await client.models.UserProfile.update({
        id: existing.id,
        appVersion,
        appBuildVersion,
        lastAppPlatform,
        lastAppOpenedAt,
    });

    if (updateResult.errors) {
        console.error(
            "[AppUsage] UserProfile update errors:",
            updateResult.errors,
        );

        throw new Error("アプリ利用情報を更新できませんでした。");
    }

    const currentUser = await getCurrentUser();

    console.log("[AppUsage] UserProfile updated:", {
        userId: currentUser.userId,
        appVersion,
        appBuildVersion,
        lastAppPlatform,
        lastAppOpenedAt,
    });
}

export async function getCurrentUserProfile(): Promise<CurrentUserProfile> {
    const user = await getCurrentUser();
    const attributes = await fetchUserAttributes();

    const email = attributes.email ?? user.signInDetails?.loginId ?? "";

    const existing = await findExistingUserProfile(user.userId);

    if (existing) {
        return {
            id: existing.id,
            userId: existing.userId,
            email: existing.email ?? email,
            displayName: existing.displayName ?? "",
            ownerValue: existing.ownerValue ?? null,
            iconImagePath: existing.iconImagePath ?? null,
            role: existing.role ?? null,
            weightKg: existing.weightKg ?? null,
            totalAggregationDistanceMeters:
                existing.totalAggregationDistanceMeters ?? 0,
            totalAggregationDurationSeconds:
                existing.totalAggregationDurationSeconds ?? 0,
            totalAggregationSessionCount:
                existing.totalAggregationSessionCount ?? 0,
            currentMonthKey: existing.currentMonthKey ?? null,
            currentMonthDistanceMeters:
                existing.currentMonthDistanceMeters ?? 0,
            currentMonthDurationSeconds:
                existing.currentMonthDurationSeconds ?? 0,
            currentMonthSessionCount: existing.currentMonthSessionCount ?? 0,
            subscriptionUsageMonthKey:
                existing.subscriptionUsageMonthKey ?? null,

            currentMonthRecordedActivityCount:
                existing.currentMonthRecordedActivityCount ?? 0,
            appVersion: existing.appVersion ?? null,
            appBuildVersion: existing.appBuildVersion ?? null,
            lastAppOpenedAt: existing.lastAppOpenedAt ?? null,
        };
    }

    await ensureUserProfile();

    const created = await findExistingUserProfile(user.userId);

    if (!created) {
        return {
            id: null,
            userId: user.userId,
            email,
            displayName: "",
            ownerValue: null,
            iconImagePath: null,
            role: null,
            weightKg: null,
            totalAggregationDistanceMeters: 0,
            totalAggregationDurationSeconds: 0,
            totalAggregationSessionCount: 0,
            currentMonthKey: null,
            currentMonthDistanceMeters: 0,
            currentMonthDurationSeconds: 0,
            currentMonthSessionCount: 0,
            subscriptionUsageMonthKey: null,
            currentMonthRecordedActivityCount: 0,
            appVersion: null,
            appBuildVersion: null,
            lastAppOpenedAt: null,
        };
    }

    return {
        id: created.id,
        userId: created.userId,
        email: created.email ?? email,
        displayName: created.displayName ?? "",
        ownerValue: created.ownerValue ?? null,
        iconImagePath: created.iconImagePath ?? null,
        role: created.role ?? null,
        weightKg: created.weightKg ?? null,
        totalAggregationDistanceMeters:
            created.totalAggregationDistanceMeters ?? 0,
        totalAggregationDurationSeconds:
            created.totalAggregationDurationSeconds ?? 0,
        totalAggregationSessionCount: created.totalAggregationSessionCount ?? 0,
        currentMonthKey: created.currentMonthKey ?? null,
        currentMonthDistanceMeters: created.currentMonthDistanceMeters ?? 0,
        currentMonthDurationSeconds: created.currentMonthDurationSeconds ?? 0,
        currentMonthSessionCount: created.currentMonthSessionCount ?? 0,
        subscriptionUsageMonthKey: created.subscriptionUsageMonthKey ?? null,
        currentMonthRecordedActivityCount:
            created.currentMonthRecordedActivityCount ?? 0,
        appVersion: created.appVersion ?? null,
        appBuildVersion: created.appBuildVersion ?? null,
        lastAppOpenedAt: created.lastAppOpenedAt ?? null,
    };
}

async function findExistingUserProfile(
    userId: string,
): Promise<UserProfileRecord | null> {
    const userProfileModel = client.models.UserProfile as any;

    const result = await userProfileModel.listUserProfilesByUserId({
        userId,
        limit: 10,
    });

    if (result.errors) {
        console.error("UserProfile query errors:", result.errors);

        throw new Error("プロフィールを取得できませんでした。");
    }

    const profiles = (result.data ?? []).filter(
        (profile: UserProfileRecord) => profile.userId === userId,
    );

    return pickUserProfile(profiles);
}

function pickUserProfile(
    profiles: UserProfileRecord[],
): UserProfileRecord | null {
    if (profiles.length === 0) {
        return null;
    }

    return (
        profiles.find(
            (profile) =>
                profile.ownerValue &&
                profile.displayName &&
                profile.displayName.trim().length > 0,
        ) ??
        profiles.find((profile) => profile.ownerValue) ??
        profiles.find(
            (profile) =>
                profile.displayName && profile.displayName.trim().length > 0,
        ) ??
        profiles[0]
    );
}

function buildSearchText(displayName: string, email: string) {
    return `${displayName} ${email}`.toLowerCase();
}
