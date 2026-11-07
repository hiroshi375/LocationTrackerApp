import { recordingLifecycle } from "./recordingLifecycleService";
import { mayReplayStoppedPoint } from "./recordingLifecycleCore";
import { hasPendingLocationQualityReview } from "./locationQualityReviewService";
import { client } from "../lib/client";
import { observeLocationDecision } from "./locationDecisionDiagnosticService";

/** The server determines sharing from current grants; queued owner arrays are not authoritative. */
export async function createLocationLog(input: Record<string, unknown>) {
    const { sharedOwners: _ignored, owner: _owner, ...record } = input;
    if (await hasPendingLocationQualityReview({ userId: String(record.userId ?? ""), sessionId: String(record.recordingSessionId ?? ""),
        latitude: Number(record.latitude), longitude: Number(record.longitude), recordedAtMs: Date.parse(String(record.recordedAt)) })) {
        return { data: null, errors: [{ message: "QUALITY_REVIEW_PENDING: 元の地点を保持して確認待ちです。" }] };
    }
    if (typeof record.userId === "string" && typeof record.recordingSessionId === "string" &&
        !mayReplayStoppedPoint(await recordingLifecycle.read(record.userId,record.recordingSessionId),Date.parse(String(record.recordedAt)))) {
        return { data: null, errors: [{ message: "SESSION_STOP_PENDING_REVIEW: 停止後の地点を端末に保持しています。" }] };
    }
    const operationStartedAtMs = Date.now();
    const result = await (
        client.mutations.ingestLocationLog as (args: {
            input: string;
        }) => Promise<{
            data?: { id: string; created: boolean } | null;
            errors?: unknown[];
        }>
    )({ input: JSON.stringify(record) }).catch(error => {
        observeLocationDecision(() => ({
            path: "cloud-write", stage: "cloud-result", userId: String(record.userId ?? ""),
            sessionId: String(record.recordingSessionId ?? ""), pointId: String(record.id ?? ""),
            point: { latitude: Number(record.latitude), longitude: Number(record.longitude), recordedAtMs: Date.parse(String(record.recordedAt)) },
            timing: { operationStartedAtMs }, reason: "transport-exception-result-unknown",
        }));
        throw error;
    });
    observeLocationDecision(() => ({
        path: "cloud-write", stage: "cloud-result", userId: String(record.userId ?? ""),
        sessionId: String(record.recordingSessionId ?? ""), pointId: String(record.id ?? ""),
        point: { latitude: Number(record.latitude), longitude: Number(record.longitude), recordedAtMs: Date.parse(String(record.recordedAt)) },
        timing: { operationStartedAtMs },
        reason: result.errors?.length || !result.data ? "explicit-error-or-missing-receipt"
            : result.data.created ? "confirmed-created" : "confirmed-existing",
    }));
    if (result.errors?.length || !result.data)
        return {
            data: null,
            errors: result.errors?.length
                ? result.errors
                : [{ message: "位置情報保存の結果を確認できません。" }],
        };
    // Publish only a confirmed server receipt, including an idempotent replay.
    // Keep cloud success successful even if the local cache cannot be written.
    if (typeof record.userId === "string" && typeof record.recordingSessionId === "string" &&
        typeof record.latitude === "number" && typeof record.longitude === "number" &&
        typeof record.recordedAt === "string") {
        try {
            const { acceptedLocationBaselines } = await import("./acceptedLocationBaselineService");
            await acceptedLocationBaselines.record(record.userId, record.recordingSessionId, {
                latitude: record.latitude, longitude: record.longitude, recordedAt: Date.parse(record.recordedAt),
            });
        } catch (error) { console.error("Accepted location baseline cache update failed:", error); }
    }
    if (!result.data.created)
        return {
            data: null,
            errors: [
                {
                    message:
                        "ConditionalCheckFailedException: conditional request failed (already exists)",
                },
            ],
        };
    return { data: { ...record, id: result.data.id }, errors: undefined };
}
