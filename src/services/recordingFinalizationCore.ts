/** A durable receipt for plan-limit stops. No GPS data or cloud ACL is stored here. */
export type PlanStopReceipt = {
    userId: string;
    recordingSessionId: string;
    reason: "FREE_PLAN_DURATION_LIMIT" | "FREE_PLAN_POINT_LIMIT";
    stoppedAt: string;
    intervalMs: number;
    distanceMeters: number;
    sharedOwners: string[];
    phase: "stopping" | "ready";
};
export const planStopReceiptKey = (userId: string) =>
    `location-tracker-pending-plan-stop:${encodeURIComponent(userId)}`;

type Storage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};
export function createPlanStopReceiptStore(storage: Storage) {
    let tail: Promise<unknown> = Promise.resolve();
    function serial<T>(work: () => Promise<T>): Promise<T> {
        const result = tail.then(work);
        tail = result.catch(() => {});
        return result;
    }
    async function read(userId: string): Promise<PlanStopReceipt | null> {
        const raw = await storage.getItem(planStopReceiptKey(userId));
        if (!raw) return null;
        const value = JSON.parse(raw) as PlanStopReceipt;
        if (value.userId !== userId || !value.recordingSessionId ||
            !["FREE_PLAN_DURATION_LIMIT", "FREE_PLAN_POINT_LIMIT"].includes(value.reason) ||
            !["stopping", "ready"].includes(value.phase) ||
            !Number.isFinite(Date.parse(value.stoppedAt)) ||
            !Number.isFinite(value.intervalMs) || value.intervalMs <= 0 ||
            !Number.isFinite(value.distanceMeters) || value.distanceMeters < 0 ||
            !Array.isArray(value.sharedOwners) || value.sharedOwners.some(x => typeof x !== "string")) {
            throw new Error("保存待ちの記録情報を読み込めません。データを保持して処理を中止しました。");
        }
        return value;
    }
    return {
        read: (userId: string) => serial(() => read(userId)),
        prepare: (receipt: PlanStopReceipt) => serial(async () => {
            const existing = await read(receipt.userId);
            if (existing && existing.recordingSessionId !== receipt.recordingSessionId)
                throw new Error("前のアクティビティの保存確認を完了してください。");
            if (!existing) await storage.setItem(planStopReceiptKey(receipt.userId), JSON.stringify(receipt));
            return existing ?? receipt;
        }),
        ready: (userId: string, sessionId: string) => serial(async () => {
            const existing = await read(userId);
            if (!existing || existing.recordingSessionId !== sessionId) return null;
            const ready = { ...existing, phase: "ready" as const };
            await storage.setItem(planStopReceiptKey(userId), JSON.stringify(ready));
            return ready;
        }),
        acknowledge: (userId: string, sessionId: string) => serial(async () => {
            const existing = await read(userId);
            if (existing?.recordingSessionId === sessionId)
                await storage.removeItem(planStopReceiptKey(userId));
        }),
    };
}
