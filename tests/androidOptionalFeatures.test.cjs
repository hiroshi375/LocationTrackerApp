const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyOptionalFeatures } = require('../plugins/withAndroidOptionalFeatures');

test('only installation filters change; orientation, permissions and other requirements survive', () => {
    const manifest = { manifest: {
        'uses-permission': [{ $: { 'android:name': 'android.permission.ACCESS_WIFI_STATE' } }],
        application: [{ activity: [{ $: { 'android:screenOrientation': 'portrait' } }] }],
        'uses-feature': [
            { $: { 'android:name': 'android.hardware.wifi', 'android:required': 'true' } },
            { $: { 'android:glEsVersion': '0x00020000', 'android:required': 'true' } },
        ],
    } };
    const original = structuredClone(manifest);
    applyOptionalFeatures(manifest);
    const once = structuredClone(manifest);
    applyOptionalFeatures(manifest);
    assert.deepEqual(manifest, once);
    for (const name of ['android.hardware.wifi', 'android.hardware.screen.portrait']) {
        const matches = manifest.manifest['uses-feature'].filter(f => f.$['android:name'] === name);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].$['android:required'], 'false');
    }
    assert.deepEqual(manifest.manifest.application, original.manifest.application);
    assert.deepEqual(manifest.manifest['uses-permission'], original.manifest['uses-permission']);
    assert.deepEqual(manifest.manifest['uses-feature'][1], original.manifest['uses-feature'][1]);
});

test('adds both optional declarations to a manifest without uses-feature', () => {
    const manifest = { manifest: {} };
    applyOptionalFeatures(manifest);
    assert.equal(manifest.manifest['uses-feature'].length, 2);
    assert.ok(manifest.manifest['uses-feature'].every(f => f.$['android:required'] === 'false'));
});
