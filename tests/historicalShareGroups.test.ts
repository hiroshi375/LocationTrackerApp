import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnsharedHistoricalGroups } from "../src/services/historicalShareGroups";
test("eligible groups exclude active grants, busy groups and duplicate entries", () => {
    const groups = [
        { groupId: "A", name: "A", members: [{ userId: "B" }] },
        { groupId: "B", name: "B", members: [{ userId: "B" }] },
        { groupId: "C", name: "C", members: [{ userId: "C" }] },
    ];
    const ids = (grants: Parameters<typeof getUnsharedHistoricalGroups>[1]) =>
        getUnsharedHistoricalGroups(groups, grants, "B").map((g) => g.groupId);
    assert.deepEqual(ids([]), ["A", "B"]);
    assert.deepEqual(
        ids([{ groupId: "A", recipientUserId: "B", isActive: true }]),
        ["B"],
    );
    assert.deepEqual(
        ids([{ groupId: "A", recipientUserId: "B", isActive: false }]),
        ["A", "B"],
    );
    assert.deepEqual(
        ids([{ groupId: "A", recipientUserId: "C", isActive: true }]),
        ["A", "B"],
    );
    assert.deepEqual(
        ids(
            ["A", "B"].map((groupId) => ({
                groupId,
                recipientUserId: "B",
                isActive: true,
            })),
        ),
        [],
    );
    assert.deepEqual(
        getUnsharedHistoricalGroups([...groups, groups[0]], [], "B").map(
            (g) => g.groupId,
        ),
        ["A", "B"],
    );
    assert.deepEqual(getUnsharedHistoricalGroups([], [], "B"), []);
    for (const lifecycle of ["CHANGING", "DISABLED", "DELETED"]) {
        assert.deepEqual(
            getUnsharedHistoricalGroups([{ ...groups[0], lifecycle }], [], "B"),
            [],
        );
    }
});
