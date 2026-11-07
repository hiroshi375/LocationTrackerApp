import * as SQLite from "expo-sqlite";
import {
  createRecordingLifecycleStore,
  initializeRecordingLifecycleDatabase,
} from "./recordingLifecycleCore";
let database: Promise<SQLite.SQLiteDatabase> | undefined;
async function open() {
  if (!database)
    database = SQLite.openDatabaseAsync("recording-lifecycle.db")
      .then(async (db) => {
        await db.execAsync(
          "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
        );
        await initializeRecordingLifecycleDatabase(db);
        return db;
      })
      .catch((error) => {
        database = undefined;
        throw error;
      });
  return database;
}
export const recordingLifecycle = createRecordingLifecycleStore(open);
