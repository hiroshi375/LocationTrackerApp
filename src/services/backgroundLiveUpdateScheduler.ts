/** One in-flight live update; historical log uploads run independently. */
export function createBackgroundLiveUpdateScheduler(
    intervalMs = 30_000,
    maxLocationAgeMs = 90_000,
) {
    let inFlight = false;
    let lastKey: string | null = null;
    let lastSuccessAt = -Infinity;
    let latestStartedLocationAt = -Infinity;

    return {
        start<T extends { succeeded: boolean }>(params: {
            key: string;
            recordedAtMs: number;
            nowMs: number;
            send: () => Promise<T>;
        }): Promise<T> | null {
            const { key, recordedAtMs, nowMs, send } = params;
            // Old OS/job batches are history, not the current location.
            if (!Number.isFinite(recordedAtMs) || !Number.isFinite(nowMs) ||
                nowMs - recordedAtMs > maxLocationAgeMs ||
                recordedAtMs - nowMs > 10_000 || inFlight) return null;
            if (lastKey !== key) {
                lastKey = key;
                lastSuccessAt = -Infinity;
                latestStartedLocationAt = -Infinity;
            }
            if (recordedAtMs <= latestStartedLocationAt ||
                nowMs - lastSuccessAt < intervalMs) return null;
            inFlight = true;
            const previousLocationAt = latestStartedLocationAt;
            latestStartedLocationAt = recordedAtMs;
            // Convert synchronous throws to rejection so cleanup always runs.
            return Promise.resolve().then(send).then(result => {
                if (result.succeeded) lastSuccessAt = nowMs;
                else latestStartedLocationAt = previousLocationAt;
                return result;
            }, error => {
                latestStartedLocationAt = previousLocationAt;
                throw error;
            }).finally(() => { inFlight = false; });
        },
    };
}
