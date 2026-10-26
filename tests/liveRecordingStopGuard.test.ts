import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopMatchingLiveRecording } from '../src/services/liveRecordingStopGuard';

const state = { userId: 'owner', shareRevision: 7, isRecording: true, recordingSessionId: 'previous' };
function run(current: typeof state | null, stop: (revision: number, session: string) => Promise<void>) {
    return stopMatchingLiveRecording({ userId: 'owner', expectedRevision: 7,
        expectedRecordingSessionId: 'previous', read: async () => current, stop });
}
test('full stop finishes its matching cloud recording before revoking sharing', async () => {
    const calls: unknown[] = [];
    await run(state, async (...args) => { calls.push(args); });
    assert.deepEqual(calls, [[7, 'previous']]);
});
test('an idle or absent live row needs no recording mutation', async () => {
    const fail = async () => { assert.fail('must not mutate idle state'); };
    await run(null, fail);
    await run({ ...state, isRecording: false }, fail);
});
test('different owner, revision or recording is preserved', async () => {
    for (const changed of [{ userId: 'other' }, { shareRevision: 8 }, { recordingSessionId: 'new' }]) {
        await assert.rejects(run({ ...state, ...changed }, async () => assert.fail('must not stop replacement')),
            /CONFLICT/);
    }
});
test('read and conditional-write failures propagate; callers must not proceed to revoke', async () => {
    await assert.rejects(run(state, async () => { throw new Error('conditional write conflict'); }), /conditional write conflict/);
    await assert.rejects(stopMatchingLiveRecording({ userId: 'owner', expectedRevision: 7,
        expectedRecordingSessionId: 'previous', read: async () => { throw new Error('offline'); },
        stop: async () => assert.fail('must not write after failed read') }), /offline/);
});
