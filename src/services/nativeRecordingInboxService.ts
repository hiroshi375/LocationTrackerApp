import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { fetchAuthSession } from "aws-amplify/auth";
import type { LocationObject } from "expo-location";
import { handoffRecordingInboxBatch, type RecordingDeliveryContext, type RecordingInboxBatch } from "./nativeRecordingInboxCore";

type InboxModule = {
    readAcLogRecordingInboxAsync: (userId: string, sessionId: string) => Promise<string | null>;
    ackAcLogRecordingInboxAsync: (userId: string, sessionId: string, ids: number[]) => Promise<void>;
    sealAcLogRecordingInboxAsync: (userId: string, sessionId: string, closed: boolean) => Promise<void>;
    discardAcLogMotionEvidenceAsync?: (userId: string, sessionId: string) => Promise<void>;
    deleteAcLogRecordingInboxOwnerAsync: (userId: string) => Promise<void>;
};

function inboxModule(): InboxModule | null {
    if (Platform.OS !== "android") return null;
    const native = requireOptionalNativeModule<InboxModule>("ExpoLocation");
    return native?.readAcLogRecordingInboxAsync ? native : null;
}

export function nativeRecordingDeliveryOptions(state: {
    isRecording: boolean;
    userId: string; recordingSessionId?: string | null; startedAt?: string | null;
    intervalMs: number; distanceMeters: number;
}): { aclogRecordingContext?: string } {
    if (!state.isRecording || !inboxModule() || !state.recordingSessionId || !state.startedAt) return {};
    const startedAtMs = Date.parse(state.startedAt);
    if (!Number.isFinite(startedAtMs)) throw new Error("INVALID_NATIVE_RECORDING_START");
    const context: RecordingDeliveryContext = { userId: state.userId, recordingSessionId: state.recordingSessionId,
        startedAtMs, intervalMs: state.intervalMs, distanceMeters: state.distanceMeters };
    return { aclogRecordingContext: JSON.stringify(context) };
}

export async function receiveNativeRecordingInbox(serialized: string, upload = true): Promise<void> {
    const native = inboxModule();
    if (!native) throw new Error("NATIVE_RECORDING_INBOX_UNAVAILABLE");
    const batch = JSON.parse(serialized) as RecordingInboxBatch;
    await handoffRecordingInboxBatch({ batch,
        persist: async ({ context, rows }) => {
            const { enqueueLocationBatchForAudit } = await import("./locationLocationQueueService");
            return enqueueLocationBatchForAudit({ userId: context.userId, recordingSessionId: context.recordingSessionId,
                source: "background", locations: rows.map(r => r.location as LocationObject), receivedAt: new Date().toISOString() });
        },
        acknowledge: (context, ids) => native.ackAcLogRecordingInboxAsync(context.userId, context.recordingSessionId, ids),
    });
    if (!upload) return;
    // Local handoff is safe even after logout; cloud transmission requires the captured owner.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const auth = await Promise.race([fetchAuthSession(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("INBOX_AUTH_TIMEOUT")), 10_000);
        })]);
        if (auth.tokens?.idToken?.payload.sub !== batch.context.userId) return;
        const { drainLocationQueueSafely } = await import("./locationQueueUploadService");
        await drainLocationQueueSafely({ ...batch.context, forceIncludeRecent: true, maxItems: 25 });
    } finally { if (timer) clearTimeout(timer); }
}

export async function sealAndFlushNativeRecordingInbox(userId: string, sessionId: string): Promise<void> {
    const native = inboxModule(); if (!native) return;
    await native.sealAcLogRecordingInboxAsync(userId, sessionId, true);
    for (let page = 0; page < 100; page++) {
        const batch = await native.readAcLogRecordingInboxAsync(userId, sessionId);
        if (!batch) return;
        const captured = JSON.parse(batch) as RecordingInboxBatch;
        if (captured.context.userId !== userId || captured.context.recordingSessionId !== sessionId)
            throw new Error("NATIVE_RECORDING_INBOX_SCOPE_MISMATCH");
        await receiveNativeRecordingInbox(batch, false);
    }
    throw new Error("NATIVE_RECORDING_INBOX_STILL_PENDING");
}

export async function resumeNativeRecordingInbox(userId: string, sessionId: string): Promise<void> {
    await inboxModule()?.sealAcLogRecordingInboxAsync(userId, sessionId, false);
}

export async function deleteNativeRecordingInboxForAccount(userId: string): Promise<void> {
    await inboxModule()?.deleteAcLogRecordingInboxOwnerAsync(userId);
}

/** Compatibility cleanup for diagnostic rows left by older native builds. Also seals late receipts. */
export async function discardNativeQualityEvidence(userId: string, sessionId: string): Promise<void> {
    await inboxModule()?.discardAcLogMotionEvidenceAsync?.(userId, sessionId);
}
