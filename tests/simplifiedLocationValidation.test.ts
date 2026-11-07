import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { selectScopedNativeLocation } from "../src/services/simplifiedLocationValidationCore";
const point = { timestamp: 100000, coords: { latitude: 35, longitude: 139, speed: 0 } };
const data = JSON.stringify({ userId: "owner", sessionId: "session", location: point });
test("UI reads background point without altering its time or coordinates", () => {
 assert.deepEqual(selectScopedNativeLocation(data,"owner","session",101000),point);
});
test("previous owner/session, stale/future/invalid caches cannot reach display or final save", () => {
 for (const [owner,session,now] of [["other","session",101000],["owner","other",101000],["owner","session",131000],["owner","session",98000]] as const)
  assert.equal(selectScopedNativeLocation(data,owner,session,now),null);
 assert.equal(selectScopedNativeLocation("bad","owner","session",101000),null);
 assert.equal(selectScopedNativeLocation(null,"owner","session",101000),null);
});
test("production flag is OFF and Native behavior requires exact isolated package plus explicit option", () => {
 assert.match(fs.readFileSync("src/config/locationValidation.ts","utf8"),/SIMPLIFIED_LOCATION_VALIDATION = false/);
 const native=fs.readFileSync("node_modules/expo-location/android/src/main/java/expo/modules/location/records/AcLogSimplifiedLocation.kt","utf8");
 assert.match(native,/packageName == "com.hiroshisato.locationtrackerapp.incident104" && options\?\.get\("aclogSimplifiedLocation"\) == true/);
});
