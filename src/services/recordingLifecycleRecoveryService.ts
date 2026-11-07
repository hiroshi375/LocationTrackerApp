import { client } from "../lib/client";
import { recordingLifecycle } from "./recordingLifecycleService";
import {
  getBackgroundRecordingStatus,
  stopBackgroundLocationRecording,
} from "./backgroundLocationService";
import type { RecordingLifecycleReceipt } from "./recordingLifecycleCore";

/** Advisory preflight only; the server transaction remains the final authority. */
export async function hasSessionSummary(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  let nextToken: string | undefined;
  do {
    const page = await client.models.RecordingSession.list({
      filter: { userId: { eq: userId }, recordingSessionId: { eq: sessionId } },
      limit: 100,
      nextToken,
    });
    if (page.errors)
      throw new Error(
        "保存状態を確認できません。データを保持して処理を中止しました。",
      );
    if (
      page.data?.some(
        (x) => x.userId === userId && x.recordingSessionId === sessionId,
      )
    )
      return true;
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);
  return false;
}
export async function ensureSessionStopped(
  userId: string,
  sessionId: string,
  settings: {
    intervalMs: number;
    distanceMeters: number;
    sharedOwners: string[];
  },
) {
  const status = await getBackgroundRecordingStatus();
  if (status.state?.userId && status.state.userId !== userId)
    throw new Error("記録の所有者が変わりました。");
  if (
    status.state?.isRecording &&
    status.state.recordingSessionId === sessionId
  )
    throw new Error(
      "記録の停止を確認できません。停止処理を完了してから保存・破棄してください。",
    );
  let r = await recordingLifecycle.read(userId, sessionId);
  if (!r) {
    r = await recordingLifecycle.requestStop({
      userId,
      sessionId,
      stoppedAtMs: Date.now(),
      ...settings,
    });
    r = await recordingLifecycle.stopped(userId, sessionId);
  }
  return r;
}
export async function retryRecordingStop(r: RecordingLifecycleReceipt) {
  const status = await getBackgroundRecordingStatus();
  if (
    status.state?.isRecording &&
    (status.state.userId !== r.userId ||
      status.state.recordingSessionId !== r.sessionId)
  )
    throw new Error("別の記録が進行中のため停止処理を再開できません。");
  await stopBackgroundLocationRecording({
    expectedRecordingSessionId: r.sessionId,
    continueLiveSharing: r.sharedOwners.length > 0,
  });
  const after = await getBackgroundRecordingStatus();
  if (
    after.state?.recordingSessionId === r.sessionId &&
    after.state.isRecording
  )
    throw new Error("停止を確認できません。");
  const current = await recordingLifecycle.read(r.userId, r.sessionId);
  if (current?.state === "STOP_REQUESTED")
    await recordingLifecycle.stopped(r.userId, r.sessionId);
}
