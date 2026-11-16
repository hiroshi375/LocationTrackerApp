import * as SQLite from "expo-sqlite";
import { createRecordingRouteReceiptStore, RECORDING_ROUTE_RECEIPT_SCHEMA } from "./recordingRouteReceiptCore";

let connection: Promise<SQLite.SQLiteDatabase> | undefined;

async function open() {
    if (!connection) {
        connection = SQLite.openDatabaseAsync("recording-route-receipts.db").then(async db => {
            try {
                await db.execAsync("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
                await db.execAsync(RECORDING_ROUTE_RECEIPT_SCHEMA);
                return db;
            } catch (error) {
                await db.closeAsync().catch(() => undefined);
                throw error;
            }
        }).catch(error => {
            connection = undefined;
            throw error;
        });
    }
    return connection;
}

export const recordingRouteReceipts = createRecordingRouteReceiptStore(open);
