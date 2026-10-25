const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function fixture(existing = null, foreign = false) {
    const writes = [], logWrites = [];
    const input = [
        { id: 'first', userId: 'A', recordingSessionId: 's', latitude: 35, longitude: 139,
            recordedAt: '2026-10-31T23:59:50+09:00', activityType: 'WALKING', isAggregationTarget: true },
        { id: 'last', userId: 'A', recordingSessionId: 's', latitude: 35, longitude: 139,
            recordedAt: '2026-11-01T00:01:00+09:00', activityType: 'WALKING', isAggregationTarget: true },
    ];
    if (foreign) input.push({ ...input[1], id: 'foreign', userId: 'B', recordedAt: '2026-12-01T00:00:00+09:00' });
    function load(path, mockedRequire) {
        const output = {};
        const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        new Function('exports', 'require', code)(output, mockedRequire);
        return output;
    }
    const route = load('src/lib/locationRoute.ts', () => { throw Error('unexpected import'); });
    const period = load('src/lib/recordingPeriod.ts', () => { throw Error('unexpected import'); });
    const write = async value => { writes.push(value); return { data: value }; };
    const client = { models: {
        LocationLog: { listLocationLogsBySessionAndRecordedAt: async () => ({ data: input }),
            update: async value => { logWrites.push(value); return { data: value }; } },
        RecordingSession: { list: async () => ({ data: existing ? [existing] : [] }), create: write, update: write },
    } };
    const service = load('src/services/recordingSessionService.ts', name => {
        if (name === 'aws-amplify/auth') return { getCurrentUser: async () => ({ userId: 'A' }) };
        if (name === '../lib/client') return { client };
        if (name === '../lib/locationRoute') return route;
        if (name === '../lib/recordingPeriod') return period;
        if (name === './activityClassificationService') return {
            classifyActivitySession: () => ({ activityType: 'WALKING', isAggregationTarget: true, movingDurationSeconds: 70 }),
            normalizeActivityType: value => value, isAggregationTargetActivityType: () => true,
        };
        if (name === './userActivityAggregationService') return {
            createMonthKey: value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date(value)),
        };
        throw Error(`Unexpected dependency: ${name}`);
    });
    return { input, writes, logWrites, save: () => service.upsertRecordingSessionSummary('s', 'saved', [], 30000, 50,
        { skipAggregation: true, skipSubscriptionUsageRecalculation: true }) };
}

test('new summary persists raw stationary end and correct month without rewriting GPS', async () => {
    const f = fixture(); const before = structuredClone(f.input);
    await f.save();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].startedAt, f.input[0].recordedAt);
    assert.equal(f.writes[0].endedAt, f.input[1].recordedAt);
    assert.equal(f.writes[0].monthKey, '2026-11');
    assert.equal(f.writes[0].distanceMeters, 0);
    assert.equal(f.writes[0].pointCount, 2);
    assert.deepEqual(f.input, before);
    assert.equal(f.logWrites.length, 0);
});

test('saving an existing manual summary preserves identity and excludes another owner time', async () => {
    const f = fixture({ id: 'existing', userId: 'A', recordingSessionId: 's', classificationSource: 'MANUAL', activityType: 'WALKING' }, true);
    await f.save();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].id, 'existing');
    assert.equal(f.writes[0].classificationSource, 'MANUAL');
    assert.equal(f.writes[0].endedAt, f.input[1].recordedAt);
    assert.equal(f.writes[0].pointCount, 2);
    assert.equal(f.logWrites.length, 0);
});
