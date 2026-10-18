const test = require('node:test');
const assert = require('node:assert/strict');
const { Amplify } = require('aws-amplify');
const { generateClient } = require('aws-amplify/data');

test('packaged API definition exposes account deletion and existing recording entry points', () => {
    Amplify.configure(require('../amplify_outputs.json'));
    const client = generateClient();
    assert.equal(typeof client.mutations.deleteCurrentAccountData, 'function');
    assert.equal(typeof client.mutations.ingestLocationLog, 'function');
    assert.equal(typeof client.mutations.setHistoricalShareGrant, 'function');
    assert.equal(typeof client.models.RecordingSession.create, 'function');
    assert.equal(typeof client.models.LocationLog.create, 'function');
});
