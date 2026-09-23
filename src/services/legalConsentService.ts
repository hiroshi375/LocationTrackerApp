import { getCurrentUser } from "aws-amplify/auth";

import { client } from "../lib/client";
import { ensureUserProfile } from "./userProfileService";

/*
 * 現在の利用規約・プライバシーポリシーのバージョン。
 *
 * 今回は「初回同意のみ」で判定するため、
 * バージョンが変わっても自動的な再同意は行わない。
 *
 * ただし、同意時点のバージョンはDBへ保存しておく。
 */
export const CURRENT_TERMS_VERSION = "2026-09-23";
export const CURRENT_PRIVACY_POLICY_VERSION = "2026-09-23";

export type LegalConsentStatus = {
    hasAccepted: boolean;

    termsAcceptedAt: string | null;
    termsVersion: string | null;

    privacyPolicyAcceptedAt: string | null;
    privacyPolicyVersion: string | null;
};

type UserProfileConsentRecord = {
    id: string;
    userId: string;

    termsAcceptedAt?: string | null;
    termsVersion?: string | null;

    privacyPolicyAcceptedAt?: string | null;
    privacyPolicyVersion?: string | null;
};

type UserProfileConsentQueryResult = {
    data?: UserProfileConsentRecord[] | null;
    errors?: readonly unknown[] | null;
};

/*
 * 現在ユーザーのUserProfileを取得する。
 */
async function getCurrentConsentProfile(): Promise<UserProfileConsentRecord> {
    const user = await getCurrentUser();

    /*
     * 新規ユーザーではUserProfileがまだ存在しない可能性があるため、
     * 先に既存処理でプロフィールを保証する。
     */
    await ensureUserProfile();

    const userProfileModel = client.models.UserProfile as any;

    const result = (await userProfileModel.listUserProfilesByUserId(
        {
            userId: user.userId,
        },
        {
            limit: 10,
        },
    )) as UserProfileConsentQueryResult;

    if (result.errors?.length) {
        console.error(
            "[LegalConsent] UserProfile query errors:",
            result.errors,
        );

        throw new Error("利用規約の同意状態を確認できませんでした。");
    }

    const profile = (result.data ?? []).find(
        (item) => item.userId === user.userId,
    );

    if (!profile) {
        throw new Error("ユーザープロフィールを取得できませんでした。");
    }

    return profile;
}

/*
 * 利用規約・プライバシーポリシーへの同意状態を取得する。
 *
 * 現在は「初回同意のみ」の仕様なので、
 * versionではなくacceptedAtの有無で判定する。
 */
export async function getLegalConsentStatus(): Promise<LegalConsentStatus> {
    const profile = await getCurrentConsentProfile();

    const termsAcceptedAt = profile.termsAcceptedAt ?? null;
    const privacyPolicyAcceptedAt = profile.privacyPolicyAcceptedAt ?? null;

    return {
        hasAccepted:
            Boolean(termsAcceptedAt) && Boolean(privacyPolicyAcceptedAt),

        termsAcceptedAt,
        termsVersion: profile.termsVersion ?? null,

        privacyPolicyAcceptedAt,
        privacyPolicyVersion: profile.privacyPolicyVersion ?? null,
    };
}

/*
 * 現在の利用規約・プライバシーポリシーへ同意したことを保存する。
 */
export async function acceptLegalDocuments(): Promise<void> {
    const profile = await getCurrentConsentProfile();

    const acceptedAt = new Date().toISOString();

    const result = await client.models.UserProfile.update({
        id: profile.id,

        termsAcceptedAt: acceptedAt,
        termsVersion: CURRENT_TERMS_VERSION,

        privacyPolicyAcceptedAt: acceptedAt,
        privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    });

    if (result.errors?.length) {
        console.error(
            "[LegalConsent] UserProfile update errors:",
            result.errors,
        );

        throw new Error("利用規約への同意情報を保存できませんでした。");
    }

    console.log("[LegalConsent] Accepted:", {
        termsVersion: CURRENT_TERMS_VERSION,
        privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        acceptedAt,
    });
}
