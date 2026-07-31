/**
 * 第1段階：
 * OSから受信した位置情報をSQLiteへ複製保存する。
 *
 * falseにするとSQLiteを一切使用せず、
 * 従来のLocationLog直接保存だけで動作する。
 */
export const ENABLE_LOCATION_SQLITE_MIRROR = true;

/**
 * 第1段階ではSQLiteからLocationLogを送信しない。
 *
 * 第2段階でのみtrueに変更する想定。
 */
export const ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD = false;
