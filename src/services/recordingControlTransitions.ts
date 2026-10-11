/**
 * Phase 5-3: SQLite recording-control state transitions.
 * This module does NOT switch the existing foreground/background writers.
 * State transitions are pure and protected by the store's SQLite CAS.
 */
import {
  readRecordingControlState,
  replaceRecordingControlStateIfVersion,
  readLegacyMigrationStatus,
  type RecordingControlState,
  type RecordingControlStateStore,
} from "./backgroundRecordingStateStore";

export type TransitionResult =
  | { status: "updated"; state: RecordingControlState }
  | { status: "unchanged"; state: RecordingControlState }
  | { status: "stale" }
  | { status: "missing" };

type TransitionStore = Pick<
  RecordingControlStateStore,
  "readRecordingControlState" | "replaceRecordingControlStateIfVersion" | "readLegacyMigrationStatus"
>;

export type StartSessionArgs = {
  userId: string;
  recordingSessionId: string;
  startedAt: string;
  recordingExpiresAt?: string | null;
  intervalMs: number;
  distanceMeters: number;
  /** Must already have been confirmed by the Cloud authority. */
  shareRevision: number;
  liveShareOwnerValues: string[];
};

export type StopSessionArgs = {
  userId: string;
  recordingSessionId: string;
  expectedShareRevision: number;
};

export type StopAllArgs = {
  userId: string;
  expectedShareRevision: number;
  /** Server-confirmed revision AFTER disabling sharing, if changed. */
  confirmedShareRevision: number;
};

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function validateStart(a: StartSessionArgs): void {
  if (!a.userId || !a.recordingSessionId || !Number.isFinite(Date.parse(a.startedAt)) ||
      !(a.intervalMs > 0) || !(a.distanceMeters > 0) ||
      !isRevision(a.shareRevision) ||
      !Array.isArray(a.liveShareOwnerValues) ||
      a.liveShareOwnerValues.some(x => typeof x !== "string" || !x)) {
    throw new Error("INVALID_RECORDING_CONTROL_START");
  }
}
export function createRecordingControlTransitions(store: TransitionStore) {
  /**
   * Pure updater: no network or Android Location calls inside CAS retries.
   * Migration must be complete before ANY of these transitions are enabled.
   */
  async function updateRecordingControlWithRetry(
    userId: string,
    expected: (state: Readonly<RecordingControlState>) => boolean,
    change: (state: Readonly<RecordingControlState>) => RecordingControlState,
    attempts = 8,
  ): Promise<TransitionResult> {
    if (!userId || !Number.isSafeInteger(attempts) || attempts < 1) {
      throw new Error("INVALID_RECORDING_CONTROL_TRANSITION");
    }
    if (!(await store.readLegacyMigrationStatus())) {
      throw new Error("RECORDING_CONTROL_NOT_MIGRATED");
    }
    for (let i = 0; i < attempts; i += 1) {
      const snapshot = await store.readRecordingControlState();
      if (!snapshot) return { status: "missing" };
      if (snapshot.state.userId !== userId || !expected(snapshot.state)) {
        return { status: "stale" };
      }
      const next = change(snapshot.state);
      if (next.userId !== userId) {
        throw new Error("RECORDING_CONTROL_USER_CHANGE_FORBIDDEN");
      }
      if (JSON.stringify(next) === JSON.stringify(snapshot.state)) {
        return { status: "unchanged", state: snapshot.state };
      }
      if (await store.replaceRecordingControlStateIfVersion(snapshot.version, next)) {
        return { status: "updated", state: next };
      }
    }
    throw new Error("RECORDING_CONTROL_CAS_RETRY_EXHAUSTED");
  }

  async function startRecordingControlSession(a: StartSessionArgs): Promise<TransitionResult> {
    validateStart(a);
    return updateRecordingControlWithRetry(
      a.userId,
      s => !s.isRecording && !(s.liveShareOwnerValues?.length) &&
           // The revision must not roll back across a stop/start.
           (s.shareRevision ?? 0) <= a.shareRevision,
      s => ({
        ...s, isRecording: true, recordingSessionId: a.recordingSessionId,
        startedAt: a.startedAt, recordingExpiresAt: a.recordingExpiresAt ?? null,
        intervalMs: a.intervalMs, distanceMeters: a.distanceMeters,
        liveShareOwnerValues: [...new Set(a.liveShareOwnerValues)],
        shareRevision: a.shareRevision, liveLocationId: null,
        liveSharingStartedAt: a.liveShareOwnerValues.length ? Date.now() : null,
        lastSavedLocation: null,
      }),
    );
  }

  async function stopRecordingControlSession(a: StopSessionArgs): Promise<TransitionResult> {
    return updateRecordingControlWithRetry(
      a.userId,
      s => s.isRecording &&
           s.recordingSessionId === a.recordingSessionId &&
           s.shareRevision === a.expectedShareRevision,
      s => ({
        ...s, isRecording: false, recordingSessionId: null,
        startedAt: null, recordingExpiresAt: null,
        lastSavedLocation: null,
        // Preserve the sharing state and server-confirmed revision.
      }),
    );
  }

  async function continueRecordingControlSharing(a: StopSessionArgs): Promise<TransitionResult> {
    return updateRecordingControlWithRetry(
      a.userId,
      s => s.isRecording &&
           s.recordingSessionId === a.recordingSessionId &&
           (s.liveShareOwnerValues?.length ?? 0) > 0 &&
           s.shareRevision === a.expectedShareRevision,
      s => ({
        ...s, isRecording: false, recordingSessionId: null,
        startedAt: null, recordingExpiresAt: null,
        lastSavedLocation: null,
        // liveShareOwnerValues, liveLocationId, shareRevision stay intact.
      }),
    );
  }

  async function stopRecordingControlCompletely(a: StopAllArgs): Promise<TransitionResult> {
    if (!isRevision(a.confirmedShareRevision) ||
        a.confirmedShareRevision < a.expectedShareRevision) {
      throw new Error("INVALID_RECORDING_CONTROL_STOP_REVISION");
    }
    return updateRecordingControlWithRetry(
      a.userId,
      s => s.shareRevision === a.expectedShareRevision,
      s => ({
        ...s, isRecording: false, recordingSessionId: null,
        startedAt: null, recordingExpiresAt: null,
        liveShareOwnerValues: [], liveLocationId: null,
        liveSharingStartedAt: null, lastSavedLocation: null,
        shareRevision: a.confirmedShareRevision,
      }),
    );
  }

  return {
    updateRecordingControlWithRetry,
    startRecordingControlSession,
    stopRecordingControlSession,
    continueRecordingControlSharing,
    stopRecordingControlCompletely,
  };
}

// Production bindings are deliberately not called until FG and BG cutover
// is implemented together and migration has completed.
export const recordingControlTransitions = createRecordingControlTransitions({
  readLegacyMigrationStatus,
  readRecordingControlState,
  replaceRecordingControlStateIfVersion,
});
