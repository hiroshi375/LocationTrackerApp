/**
 * OS受信地点をSQLiteへ複製保存する。
 */
export const ENABLE_LOCATION_SQLITE_MIRROR = true;

/**
 * SQLiteの未処理キューからLocationLogを送信する。
 *
 * 問題が発生した場合はfalseに戻す。
 */
export const ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD = true;

/**
 * 第2段階では、既存の直接保存経路を残す。
 *
 * SQLite再送の検証が完了するまでは必ずtrueにする。
 */
export const KEEP_DIRECT_LOCATION_LOG_SAVE = true;

/**
 * 直接保存処理と競合しないよう、
 * SQLiteへ入ってから一定時間以上経過した地点だけ再送対象にする。
 */
export const SQLITE_QUEUE_UPLOAD_MIN_AGE_MS = 10_000;

/**
 * 1回のbackground callbackで処理する最大件数。
 *
 * 新しい位置情報の直接保存を優先するため、
 * SQLite pendingの再送は少量ずつ行う。
 */
export const SQLITE_QUEUE_UPLOAD_MAX_ITEMS = 5;

/**
 * SQLiteキュー送信処理全体の最大時間。
 */
export const SQLITE_QUEUE_UPLOAD_TIME_BUDGET_MS = 5_000;

/**
 * LocationLog.create() 1回あたりの待機上限。
 *
 * Promise自体は完全にはキャンセルされないが、
 * background処理全体が数分止まることを避ける。

 * 全体5秒の予算を超えにくくするため、
 * create単体は4秒までとする。
 */
export const SQLITE_QUEUE_CREATE_TIMEOUT_MS = 4_000;
