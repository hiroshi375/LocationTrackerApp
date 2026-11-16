import type { RecordingDeliveryContext, RecordingInboxBatch } from "./nativeRecordingInboxCore";
import type { RecordingRoutePoint } from "./recordingRouteProjection";

export const RECORDING_ROUTE_RECEIPT_SCHEMA = `CREATE TABLE IF NOT EXISTS recording_route_receipt (
    owner TEXT NOT NULL, session TEXT NOT NULL, stamp INTEGER NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL, speed REAL,
    started_at INTEGER NOT NULL, interval_ms INTEGER NOT NULL, distance_meters REAL NOT NULL,
    PRIMARY KEY(owner, session, stamp, latitude, longitude)
);
CREATE TABLE IF NOT EXISTS recording_route_receipt_removed (
    owner TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY(owner, session)
);`;

type ReceiptDatabase = {
    runAsync(sql: string, params: (string | number | null)[]): Promise<unknown>;
    getAllAsync<Row>(sql: string, params: string[]): Promise<Row[]>;
};
type ReceiptRow = RecordingRoutePoint & { startedAtMs: number; intervalMs: number; distanceMeters: number };
const validMeasure = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function createRecordingRouteReceiptStore(open: () => Promise<ReceiptDatabase>) {
    return {
        async append({ context, rows }: RecordingInboxBatch): Promise<void> {
            const values = rows.flatMap(({ location }) => {
                const accuracy = location.aclogRouteAccuracy;
                if (location.mocked === true || !validMeasure(accuracy) || location.timestamp < context.startedAtMs) return [];
                return [[context.userId, context.recordingSessionId, location.timestamp, location.coords.latitude, location.coords.longitude,
                    accuracy, validMeasure(location.aclogRouteSpeed) ? location.aclogRouteSpeed : null,
                    context.startedAtMs, context.intervalMs, context.distanceMeters]];
            });
            if (!values.length) return;
            const db = await open();
            await db.runAsync(`WITH batch(owner, session, stamp, latitude, longitude, accuracy, speed, started_at, interval_ms, distance_meters) AS (
                VALUES ${values.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")}
            )
            INSERT OR IGNORE INTO recording_route_receipt
                (owner, session, stamp, latitude, longitude, accuracy, speed, started_at, interval_ms, distance_meters)
            SELECT * FROM batch WHERE NOT EXISTS (
                SELECT 1 FROM recording_route_receipt_removed removed
                WHERE removed.owner = batch.owner AND removed.session IN ('', batch.session)
            )`, values.flat());
        },
        async read(userId: string, sessionId: string): Promise<{ context: RecordingDeliveryContext; receipts: RecordingRoutePoint[] } | null> {
            const db = await open();
            const rows = await db.getAllAsync<ReceiptRow>(`SELECT stamp AS recordedAtMs, latitude, longitude, accuracy, speed,
                started_at AS startedAtMs, interval_ms AS intervalMs, distance_meters AS distanceMeters
                FROM recording_route_receipt receipt WHERE owner = ? AND session = ? AND NOT EXISTS (
                    SELECT 1 FROM recording_route_receipt_removed removed
                    WHERE removed.owner = receipt.owner AND removed.session IN ('', receipt.session)
                ) ORDER BY stamp, latitude, longitude`, [userId, sessionId]);
            if (!rows.length) return null;
            const { startedAtMs, intervalMs, distanceMeters } = rows[0];
            if (rows.some(row => row.startedAtMs !== startedAtMs || row.intervalMs !== intervalMs || row.distanceMeters !== distanceMeters)) return null;
            return {
                context: { userId, recordingSessionId: sessionId, startedAtMs, intervalMs, distanceMeters },
                receipts: rows.map(({ recordedAtMs, latitude, longitude, accuracy, speed }) => ({ recordedAtMs, latitude, longitude, accuracy, speed })),
            };
        },
        async removeSession(userId: string, sessionId: string): Promise<void> {
            const db = await open();
            await db.runAsync("INSERT OR IGNORE INTO recording_route_receipt_removed(owner, session) VALUES (?, ?)", [userId, sessionId]);
            await db.runAsync("DELETE FROM recording_route_receipt WHERE owner = ? AND session = ?", [userId, sessionId]);
        },
        async removeOwner(userId: string): Promise<void> {
            const db = await open();
            // Empty session fences all late deliveries for this deleted owner.
            await db.runAsync("INSERT OR IGNORE INTO recording_route_receipt_removed(owner, session) VALUES (?, '')", [userId]);
            await db.runAsync("DELETE FROM recording_route_receipt WHERE owner = ?", [userId]);
        },
    };
}
