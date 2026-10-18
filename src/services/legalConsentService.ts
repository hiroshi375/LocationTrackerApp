import { getCurrentUser } from "aws-amplify/auth";

import { client } from "../lib/client";
import { ensureUserProfile } from "./userProfileService";

import {
    ACTIVE_LEGAL_DOCUMENT_VERSION,
    PENDING_LEGAL_DOCUMENT_VERSION,
    LEGAL_DOCUMENTS_V2_ENABLED,
    evaluateLegalConsent,
} from "./legalConsentPolicy";

// Match the consent version to the documents displayed by the application.
export const CURRENT_TERMS_VERSION = LEGAL_DOCUMENTS_V2_ENABLED
    ? PENDING_LEGAL_DOCUMENT_VERSION : ACTIVE_LEGAL_DOCUMENT_VERSION;
export const CURRENT_PRIVACY_POLICY_VERSION = CURRENT_TERMS_VERSION;

export type LegalConsentStatus = {
    hasAccepted: boolean;
    requiresRenewal: boolean;

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
 * 承認済みの改定を有効化した後は、両文書の同意版も照合する。
 * 取得に失敗した場合は呼び出し元の再試行画面へ戻す。
 */
export async function getLegalConsentStatus(): Promise<LegalConsentStatus> {
    const profile = await getCurrentConsentProfile();

    const termsAcceptedAt = profile.termsAcceptedAt ?? null;
    const privacyPolicyAcceptedAt = profile.privacyPolicyAcceptedAt ?? null;

    return {
        ...evaluateLegalConsent(profile, {
            terms: CURRENT_TERMS_VERSION,
            privacy: CURRENT_PRIVACY_POLICY_VERSION,
        }, LEGAL_DOCUMENTS_V2_ENABLED),

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

    if (result.errors?.length || !result.data) {
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
