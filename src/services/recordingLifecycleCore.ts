/** Separate journal: recording queue rows are never removed by these operations. */
export type RecordingLifecycleState =
  | "STOP_REQUESTED"
  | "STOPPED"
  | "SAVE_REQUESTED"
  | "SAVED"
  | "DISCARD_REQUESTED"
  | "DISCARDED";
export type RecordingLifecycleReceipt = {
  userId: string;
  sessionId: string;
  state: RecordingLifecycleState;
  stoppedAtMs: number;
  startedAtMs?: number | null;
  intervalMs: number;
  distanceMeters: number;
  sharedOwners: string[];
  saveName?: string | null;
};
export type LifecycleDatabase = {
  execAsync(sql: string): Promise<unknown>;
  runAsync(sql: string, values: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(
    sql: string,
    values: (string | number | null)[],
  ): Promise<T | null>;
  getAllAsync<T>(sql: string, values: (string | number | null)[]): Promise<T[]>;
};
export const LIFECYCLE_SCHEMA = `CREATE TABLE IF NOT EXISTS recording_lifecycle (
 user_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL,
 stopped_at_ms REAL NOT NULL, interval_ms REAL NOT NULL, distance_meters REAL NOT NULL,
 shared_owners TEXT NOT NULL, save_name TEXT, started_at_ms REAL, PRIMARY KEY(user_id,session_id));`;
type Row = {
  user_id: string;
  session_id: string;
  state: RecordingLifecycleState;
  stopped_at_ms: number;
  started_at_ms?: number | null;
  interval_ms: number;
  distance_meters: number;
  shared_owners: string;
  save_name: string | null;
};
/** Additive migration: old receipts and queue payloads are left intact. */
export async function initializeRecordingLifecycleDatabase(db: LifecycleDatabase) {
  await db.execAsync(LIFECYCLE_SCHEMA);
  const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(recording_lifecycle)", []);
  if (!columns.some(column => column.name === "started_at_ms"))
    await db.execAsync("ALTER TABLE recording_lifecycle ADD COLUMN started_at_ms REAL");
}
export function createRecordingLifecycleStore(
  open: () => Promise<LifecycleDatabase>,
) {
  const validate = (u: string, s: string) => {
    if (!u?.trim() || !s?.trim())
      throw new Error("記録の所有者とセッションを特定できません。");
  };
  const decode = (r: Row | null): RecordingLifecycleReceipt | null => {
    if (!r) return null;
    if (
      ![
        "STOP_REQUESTED",
        "STOPPED",
        "SAVE_REQUESTED",
        "SAVED",
        "DISCARD_REQUESTED",
        "DISCARDED",
      ].includes(r.state) ||
      !Number.isFinite(r.stopped_at_ms)
    )
      throw new Error("記録の終了状態を確認できません。データを保持しました。");
    const owners = JSON.parse(r.shared_owners);
    if (
      !Array.isArray(owners) ||
      owners.some((x) => typeof x !== "string") ||
      !Number.isFinite(r.interval_ms) ||
      r.interval_ms <= 0 ||
      !Number.isFinite(r.distance_meters) ||
      r.distance_meters < 0
    )
      throw new Error("記録の終了情報が不正です。データを保持しました。");
    return {
      userId: r.user_id,
      sessionId: r.session_id,
      state: r.state,
      stoppedAtMs: r.stopped_at_ms,
      startedAtMs: r.started_at_ms ?? null,
      intervalMs: r.interval_ms,
      distanceMeters: r.distance_meters,
      sharedOwners: owners,
      saveName: r.save_name ?? null,
    };
  };
  async function read(u: string, s: string) {
    validate(u, s);
    return decode(
      await (
        await open()
      ).getFirstAsync<Row>(
        "SELECT * FROM recording_lifecycle WHERE user_id=? AND session_id=?",
        [u, s],
      ),
    );
  }
  async function requestStop(r: Omit<RecordingLifecycleReceipt, "state">) {
    validate(r.userId, r.sessionId);
    if (
      (r.startedAtMs != null && (!Number.isFinite(r.startedAtMs) || r.startedAtMs > r.stoppedAtMs)) ||
      !Number.isFinite(r.stoppedAtMs) ||
      !Number.isFinite(r.intervalMs) ||
      r.intervalMs <= 0 ||
      !Number.isFinite(r.distanceMeters) ||
      r.distanceMeters < 0 ||
      !Array.isArray(r.sharedOwners) ||
      r.sharedOwners.some((x) => typeof x !== "string")
    )
      throw new Error("停止情報が不正です。");
    await (
      await open()
    ).runAsync(
      "INSERT OR IGNORE INTO recording_lifecycle (user_id,session_id,state,stopped_at_ms,interval_ms,distance_meters,shared_owners,started_at_ms) VALUES (?,?, 'STOP_REQUESTED',?,?,?,?,?)",
      [
        r.userId,
        r.sessionId,
        r.stoppedAtMs,
        r.intervalMs,
        r.distanceMeters,
        JSON.stringify(r.sharedOwners),
        r.startedAtMs ?? null,
      ],
    );
    return (await read(r.userId, r.sessionId))!;
  }
  async function transition(
    u: string,
    s: string,
    to: RecordingLifecycleState,
    from: RecordingLifecycleState[],
  ) {
    validate(u, s);
    await (
      await open()
    ).runAsync(
      `UPDATE recording_lifecycle SET state=? WHERE user_id=? AND session_id=? AND state IN (${from.map(() => "?").join(",")})`,
      [to, u, s, ...from],
    );
    const r = await read(u, s);
    if (!r || r.state !== to)
      throw new Error(
        "記録の終了状態が変わったため処理を中止しました。データは保持されています。",
      );
    return r;
  }
  return {
    read,
    requestStop,
    stopped: (u: string, s: string) =>
      transition(u, s, "STOPPED", ["STOP_REQUESTED", "STOPPED"]),
    prepareSave: async (u: string, s: string, name?: string) => {
      const previous = await read(u, s);
      if (previous?.state === "SAVED") return previous; // Cloud success followed by a local UI/ACK failure is retryable.
      await (
        await open()
      ).runAsync(
        "UPDATE recording_lifecycle SET state='SAVE_REQUESTED',save_name=COALESCE(save_name,?) WHERE user_id=? AND session_id=? AND state IN ('STOPPED','SAVE_REQUESTED')",
        [name ?? null, u, s],
      );
      const current = await read(u, s);
      if (!current || !["SAVE_REQUESTED", "SAVED"].includes(current.state))
        throw new Error("記録の状態が変わったため保存を中断しました。");
      return current;
    },
    // Only for a known early return before the summary API was called; never on a transport error.
    releaseUnsentSave: (u: string, s: string) => transition(u, s, "STOPPED", ["SAVE_REQUESTED"]),
    saved: (u: string, s: string) =>
      transition(u, s, "SAVED", ["SAVE_REQUESTED", "SAVED"]),
    confirmExistingSaved: (u: string, s: string) =>
      transition(u, s, "SAVED", ["STOPPED", "SAVE_REQUESTED", "SAVED"]),
    prepareDiscard: (u: string, s: string) =>
      transition(u, s, "DISCARD_REQUESTED", ["STOPPED", "DISCARD_REQUESTED"]),
    discarded: (u: string, s: string) =>
      transition(u, s, "DISCARDED", ["DISCARD_REQUESTED", "DISCARDED"]),
    pending: async (u: string) => {
      if (!u?.trim()) throw new Error("所有者を確認できません。");
      return (
        await (
          await open()
        ).getAllAsync<Row>(
          "SELECT * FROM recording_lifecycle WHERE user_id=? AND state NOT IN ('SAVED','DISCARDED') ORDER BY stopped_at_ms",
          [u],
        )
      ).map((x) => decode(x)!);
    },
  };
}
export function mayReplayStoppedPoint(
  r: RecordingLifecycleReceipt | null,
  recordedAtMs: number,
): boolean {
  return (
    !r ||
    (r.state !== "DISCARD_REQUESTED" &&
      r.state !== "DISCARDED" &&
      Number.isFinite(recordedAtMs) &&
      recordedAtMs <= r.stoppedAtMs)
  );
}
