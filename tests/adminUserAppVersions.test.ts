import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AdminAppVersionsAccessError, formatAppOpenedAtJst,
    normalizeUserAppVersions, readAdminUserAppVersions,
} from "../src/services/adminUserAppVersionsCore";

const admin = async () => ({ userId: "admin-a", isAdmin: true });
const active = () => false;

test("sorts all pages by actual instants, missing and invalid timestamps last", async () => {
    const calls: (string | undefined)[] = [];
    const rows = await readAdminUserAppVersions(async token => {
        calls.push(token);
        return token ? { data: [
            { id: "new", lastAppOpenedAt: "2026-10-26T10:01:00Z" },
            { id: "invalid", lastAppOpenedAt: "invalid" },
        ] } : { data: [
            { id: "offset", lastAppOpenedAt: "2026-10-26T19:00:00+09:00" },
            { id: "none" },
        ], nextToken: "second" };
    }, admin, active);
    assert.deepEqual(calls, [undefined, "second"]);
    assert.deepEqual(rows?.slice(0, 2).map(x => x.id), ["new", "offset"]);
    assert.ok(rows?.slice(2).every(x => x.lastAppOpenedAt === null));
});

test("JST formatting handles fractions, offsets and year rollover without device timezone", () => {
    assert.equal(formatAppOpenedAtJst("2026-12-31T15:00:01.123Z"), "2027/01/01 00:00:01");
    assert.equal(formatAppOpenedAtJst("2026-10-26T12:34:56+09:00"), "2026/10/26 12:34:56");
    assert.equal(formatAppOpenedAtJst("1970-01-01T00:00:00Z"), "1970/01/01 09:00:00");
    assert.equal(formatAppOpenedAtJst(null), "未取得");
    assert.equal(formatAppOpenedAtJst("invalid"), "未取得");
});

test("normalizes legacy fields and does not return email or userId", () => {
    const input = [{ id: "one", displayName: "  名前  ", appBuildVersion: 0, lastAppPlatform: "ios", email: "secret", userId: "private" }, { id: "two" }, null];
    const rows = normalizeUserAppVersions(input);
    assert.equal(rows.length, 2);
    const first = rows.find(x => x.id === "one")!;
    assert.equal(first.displayName, "名前");
    assert.equal(first.appBuildVersion, 0);
    assert.equal(first.platform, "iOS");
    assert.equal("email" in first, false);
    assert.equal("userId" in first, false);
    assert.equal(rows.find(x => x.id === "two")?.appVersion, "未取得");
});

test("deduplicates overlapping pages using the newest report and keeps equal names separate", () => {
    const rows = normalizeUserAppVersions([
        { id: "a", displayName: "同名", lastAppOpenedAt: "2026-01-01T00:00:00Z", appBuildVersion: 25 },
        { id: "b", displayName: "同名", lastAppOpenedAt: "2026-01-02T00:00:00Z" },
        { id: "a", displayName: "同名", lastAppOpenedAt: "2026-01-03T00:00:00Z", appBuildVersion: 27 },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].appBuildVersion, 27);
});

test("non-admin never fetches the list", async () => {
    let read = false;
    await assert.rejects(readAdminUserAppVersions(async () => { read = true; return { data: [] }; }, async () => ({ userId: "normal", isAdmin: false }), active), AdminAppVersionsAccessError);
    assert.equal(read, false);
});

test("account change or role revocation discards the response", async () => {
    for (const changed of [{ userId: "other", isAdmin: true }, { userId: "admin-a", isAdmin: false }]) {
        let count = 0;
        await assert.rejects(readAdminUserAppVersions(async () => ({ data: [{ id: "private" }] }), async () => ++count === 1 ? admin() : changed, active), AdminAppVersionsAccessError);
    }
});

test("partial errors and repeated page tokens never return an incomplete list", async () => {
    await assert.rejects(readAdminUserAppVersions(async token => token ? { data: [], errors: ["Denied"] } : { data: [{ id: "partial" }], nextToken: "next" }, admin, active));
    await assert.rejects(readAdminUserAppVersions(async () => ({ data: [], nextToken: "repeat" }), admin, active));
    await assert.rejects(readAdminUserAppVersions(async () => ({ data: null }), admin, active));
});

test("cancelled screen does not publish stale data, including during final role check", async () => {
    let cancelled = false;
    assert.equal(await readAdminUserAppVersions(async () => { cancelled = true; return { data: [{ id: "stale" }] }; }, admin, () => cancelled), null);
    cancelled = false;
    let count = 0;
    assert.equal(await readAdminUserAppVersions(async () => ({ data: [{ id: "stale" }] }), async () => { if (++count === 2) cancelled = true; return admin(); }, () => cancelled), null);
});

test("empty pages with a token are followed and a final empty result is valid", async () => {
    const rows = await readAdminUserAppVersions(async token => token ? { data: [] } : { data: [], nextToken: "next" }, admin, active);
    assert.deepEqual(rows, []);
});
