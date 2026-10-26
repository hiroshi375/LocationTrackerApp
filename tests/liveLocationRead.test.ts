import { test } from "node:test";
import assert from "node:assert/strict";
import { readAuthorizedLiveLocations } from "../src/services/liveLocationReadCore";
const user = async () => "viewer";
const active = () => false;

test("refresh reads all authorized pages and observes revocation without subscription events", async () => {
    let revoked = false;
    const read = async (token?: string) => revoked ? { data: [] } : token
        ? { data: [{ id: "second" }] } : { data: [{ id: "first" }], nextToken: "page2" };
    assert.equal((await readAuthorizedLiveLocations(read, user, active)).length, 2);
    revoked = true;
    assert.deepEqual(await readAuthorizedLiveLocations(read, user, active), []);
});
test("account switching or cancellation discards the whole previous response", async () => {
    let identity = "A";
    assert.deepEqual(await readAuthorizedLiveLocations(async () => {
        identity = "B"; return { data: [{ id: "A-private" }] };
    }, async () => identity, active), []);
    let cancelled = false;
    assert.deepEqual(await readAuthorizedLiveLocations(async () => {
        cancelled = true; return { data: [{ id: "late" }] };
    }, user, () => cancelled), []);
});
test("partial authorization errors and repeated page tokens fail closed", async () => {
    await assert.rejects(readAuthorizedLiveLocations(async token => token
        ? { data: [], errors: ["Unauthorized"] }
        : { data: [{ id: "partial" }], nextToken: "next" }, user, active));
    await assert.rejects(readAuthorizedLiveLocations(async () => ({ data: [], nextToken: "same" }), user, active));
});


test("cancellation during the final identity lookup suppresses a late response", async () => {
    let cancelled = false;
    let calls = 0;
    const items = await readAuthorizedLiveLocations(async () => ({ data: [{ id: "late" }] }), async () => {
        if (++calls === 2) cancelled = true;
        return "viewer";
    }, () => cancelled);
    assert.deepEqual(items, []);
});
