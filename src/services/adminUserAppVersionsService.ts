import { getCurrentUser } from "aws-amplify/auth";
import { client } from "../lib/client";
import {
    readAdminUserAppVersions,
    type AdminAppVersionIdentity,
    type UserAppVersionRecord,
} from "./adminUserAppVersionsCore";

type ProfileRole = {
    userId?: string | null;
    role?: string | null;
    ownerValue?: string | null;
    displayName?: string | null;
};
type ReadResult<T> = { data?: (T | null)[] | null; errors?: unknown[]; nextToken?: string | null };
type ListOptions = { limit: number; nextToken?: string; selectionSet: string[]; authMode: "userPool" };
// Bound the generated client's selection-set types to this read-only surface.
type UserProfileReader = {
    list: (options: ListOptions) => Promise<ReadResult<UserAppVersionRecord>>;
    listUserProfilesByUserId: (options: ListOptions & { userId: string }) => Promise<ReadResult<ProfileRole>>;
};
const userProfileModel = (client as unknown as {
    models: { UserProfile: UserProfileReader };
}).models.UserProfile;

// Keep this screen read-only, including the current user's role check. Unlike
// getCurrentUserProfile(), this does not create a missing profile.
async function readAdminIdentity(): Promise<AdminAppVersionIdentity> {
    const { userId } = await getCurrentUser();
    const result = await userProfileModel.listUserProfilesByUserId({
        userId,
        limit: 10,
        selectionSet: ["userId", "role", "ownerValue", "displayName"],
        authMode: "userPool",
    });
    if (result.errors?.length) throw new Error("管理者権限を確認できませんでした。");
    const profiles = (result.data ?? []).filter((p): p is ProfileRole => p?.userId === userId);
    // Same profile preference as the existing home/profile screens.
    const profile = profiles.find(p => p.ownerValue && p.displayName?.trim()) ??
        profiles.find(p => p.ownerValue) ??
        profiles.find(p => p.displayName?.trim()) ?? profiles[0];
    return { userId, isAdmin: profile?.role === "admin" };
}

export function listAdminUserAppVersions(isCancelled: () => boolean) {
    return readAdminUserAppVersions(
        nextToken => userProfileModel.list({
            limit: 100,
            nextToken,
            selectionSet: [
                "id", "displayName", "appVersion", "appBuildVersion",
                "lastAppPlatform", "lastAppOpenedAt",
            ],
            authMode: "userPool",
        }),
        readAdminIdentity,
        isCancelled,
    );
}
