/** Approved documents and renewed consent are activated together. */
export const LEGAL_DOCUMENTS_V2_ENABLED = true;
export const PENDING_LEGAL_DOCUMENT_VERSION = "2026-10-19";
export const ACTIVE_LEGAL_DOCUMENT_VERSION = "2026-09-23";

export type ConsentRecord = {
    termsAcceptedAt?: string | null;
    termsVersion?: string | null;
    privacyPolicyAcceptedAt?: string | null;
    privacyPolicyVersion?: string | null;
};

export function evaluateLegalConsent(
    record: ConsentRecord,
    versions: { terms: string; privacy: string },
    requireCurrentVersions: boolean,
) {
    const previouslyAccepted = Boolean(record.termsAcceptedAt && record.privacyPolicyAcceptedAt);
    const versionsMatch = record.termsVersion === versions.terms &&
        record.privacyPolicyVersion === versions.privacy;
    return {
        hasAccepted: previouslyAccepted && (!requireCurrentVersions || versionsMatch),
        requiresRenewal: previouslyAccepted && requireCurrentVersions && !versionsMatch,
    };
}
