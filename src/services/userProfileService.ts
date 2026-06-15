import { fetchUserAttributes, getCurrentUser } from "aws-amplify/auth";

import { client } from "../lib/client";

type UserProfileItem = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    ownerValue?: string | null;
    owner?: string | null;
    searchText?: string | null;
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

export async function getCurrentUserProfile() {
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
        };
    }

    return {
        id: created.id,
        userId: created.userId,
        email: created.email ?? email,
        displayName: created.displayName ?? "",
        ownerValue: created.ownerValue ?? null,
    };
}

async function findExistingUserProfile(userId: string) {
    const result = await client.models.UserProfile.list({
        filter: {
            userId: {
                eq: userId,
            },
        },
        limit: 100,
    });

    if (result.errors) {
        console.error("UserProfile list errors:", result.errors);
        throw new Error("プロフィールを取得できませんでした。");
    }

    const profiles = (result.data ?? []) as UserProfileItem[];

    return pickUserProfile(profiles);
}

function pickUserProfile(profiles: UserProfileItem[]) {
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
