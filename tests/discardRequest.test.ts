import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestDiscardStep } from '../src/services/discardRequest';

test('partial discard response continues and confirmed completion finishes', async () => {
    assert.equal(await requestDiscardStep(async () => ({ data: false })), false);
    assert.equal(await requestDiscardStep(async () => ({ data: true })), true);
    await assert.rejects(requestDiscardStep(async () => ({ data: true, errors: [{ message: 'Unauthorized' }] })));
    await assert.rejects(requestDiscardStep(async () => ({ data: null })));
});
test('a stuck request times out without treating its late success as UI completion', async () => {
    let finish!: (response: { data: boolean }) => void;
    const request = new Promise<{ data: boolean }>(resolve => { finish = resolve; });
    await assert.rejects(requestDiscardStep(() => request, 5), /後で再開/);
    finish({ data: true });
    assert.equal(await requestDiscardStep(async () => ({ data: true })), true);
});
