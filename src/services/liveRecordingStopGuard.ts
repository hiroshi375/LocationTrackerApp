/** Stop only the recording owned by this stop operation, before revoking sharing. */
export async function stopMatchingLiveRecording({
    userId,
    expectedRevision,
    expectedRecordingSessionId,
    read,
    stop,
}: {
    userId: string;
    expectedRevision: number;
    expectedRecordingSessionId: string;
    read: () => Promise<{
        userId: string;
        shareRevision: number;
        isRecording: boolean;
        recordingSessionId: string | null;
    } | null>;
    stop: (revision: number, sessionId: string) => Promise<void>;
}): Promise<void> {
    const current = await read();
    if (!current) return;
    if (current.userId !== userId || current.shareRevision !== expectedRevision) {
        throw new Error("LIVE_LOCATION_RECORDING_STOP_STATE_CONFLICT");
    }
    if (!current.isRecording) return;
    if (current.recordingSessionId !== expectedRecordingSessionId) {
        throw new Error("LIVE_LOCATION_RECORDING_STOP_SESSION_CONFLICT");
    }
    // The server repeats the revision/session comparison atomically.
    await stop(expectedRevision, expectedRecordingSessionId);
}
