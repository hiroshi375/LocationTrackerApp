/**
 * Phase 5-3: shared CAS mutation helpers.
 * Not a complete cutover: activate only after every legacy state writer
 * in backgroundLocationService and backgroundLocationTask has been replaced.
 */
import {
  readLegacyMigrationStatus,
  readRecordingControlState,
  replaceRecordingControlStateIfVersion,
  type RecordingControlState,
} from './backgroundRecordingStateStore';

export type RecordingControlMutationResult =
  | { status: 'updated'; state: RecordingControlState }
  | { status: 'stale' }
  | { status: 'missing' };

type Identity = {
  userId: string;
  recordingSessionId?: string | null;
  shareRevision?: number;
};

/**
 * Returns null if the callback is stale. Never creates a new state.
 * `updater` MUST be pure and MUST NOT make network or OS calls.
 */
export async function updateRecordingControlByCas(
  identity: Identity,
  updater: (current: Readonly<RecordingControlState>) => RecordingControlState,
  maxAttempts = 8,
): Promise<RecordingControlMutationResult> {
  if (!(await readLegacyMigrationStatus())) {
    throw new Error('RECORDING_CONTROL_NOT_MIGRATED');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await readRecordingControlState();
    if (!snapshot) return { status: 'missing' };
    const state = snapshot.state;
    if (
      state.userId !== identity.userId ||
      (identity.recordingSessionId !== undefined &&
        (state.recordingSessionId ?? null) !== identity.recordingSessionId) ||
      (identity.shareRevision !== undefined &&
        state.shareRevision !== identity.shareRevision)
    ) {
      return { status: 'stale' };
    }
    const next = updater(state);
    // The callback cannot silently move the state to a different user/session.
    if (
      next.userId !== state.userId ||
      (next.recordingSessionId ?? null) !== (state.recordingSessionId ?? null)
    ) {
      throw new Error('RECORDING_CONTROL_ILLEGAL_IDENTITY_CHANGE');
    }
    const updated = await replaceRecordingControlStateIfVersion(
      snapshot.version,
      next,
    );
    if (updated) return { status: 'updated', state: next };
  }
  throw new Error('RECORDING_CONTROL_CAS_RETRY_EXHAUSTED');
}

/**
 * With an expected session ID, a callback that started before Stop cannot
 * accidentally mutate the next recording session.
 */
export async function updateRecordingControlFromCallback(
  userId: string,
  recordingSessionId: string | null,
  updater: (current: Readonly<RecordingControlState>) => RecordingControlState,
  expectedShareRevision?: number,
): Promise<RecordingControlState | null> {
  const result = await updateRecordingControlByCas(
    { userId, recordingSessionId, shareRevision: expectedShareRevision },
    (state) => {
      const proposed = updater(state);
      if (!state.isRecording && proposed.isRecording) {
        throw new Error('RECORDING_CONTROL_CALLBACK_CANNOT_RESTART');
      }
      return {
        ...proposed,
        userId: state.userId,
        recordingSessionId: state.recordingSessionId,
        liveShareOwnerValues: state.liveShareOwnerValues,
        shareRevision: state.shareRevision,
      };
    },
  );
  return result.status === 'updated' ? result.state : null;
}
