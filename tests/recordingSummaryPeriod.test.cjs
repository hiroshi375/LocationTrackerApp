const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function fixture(existing = null, foreign = false, missingReceipt = false, lifecycle = null) {
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
    const write = async value => { writes.push(value); return missingReceipt ? { data: null } : { data: value }; };
    const client = { models: {
        LocationLog: { listLocationLogsBySessionAndRecordedAt: async () => ({ data: input }),
            update: async value => { logWrites.push(value); return { data: value }; } },
        RecordingSession: { list: async () => ({ data: existing ? [existing] : [] }), create: write, update: write },
    } };
    const service = load('src/services/recordingSessionService.ts', name => {
        if (name === './recordingLifecycleService') return { recordingLifecycle: {read: async () => lifecycle} };
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

test('missing summary receipt is not reported as successful save',async()=>{
 const f=fixture(null,false,true);await assert.rejects(f.save(),/保存結果を確認できません/);
});


test('new stationary recording uses durable 62-second operation bounds, not the 36-second measurement span',async()=>{
 const start=Date.parse('2026-10-31T23:59:59+09:00');
 const f=fixture(null,false,false,{state:'SAVE_REQUESTED',startedAtMs:start,stoppedAtMs:start+62000});
 f.input[0].recordedAt=new Date(start+1).toISOString();f.input[1].recordedAt=new Date(start+36508).toISOString();
 await f.save();assert.equal(Date.parse(f.writes[0].endedAt)-Date.parse(f.writes[0].startedAt),62000);
 assert.equal(f.writes[0].distanceMeters,0);assert.equal(f.logWrites.length,0);
});
test('retry/reclassification preserves existing saved period even when receipt disagrees',async()=>{
 const existing={id:'saved',userId:'A',recordingSessionId:'s',startedAt:'2026-10-31T14:59:45.000Z',endedAt:'2026-10-31T15:00:47.000Z'};
 const f=fixture(existing,false,false,{state:'SAVED',startedAtMs:0,stoppedAtMs:999});
 await f.save();assert.equal(f.writes[0].startedAt,existing.startedAt);assert.equal(f.writes[0].endedAt,existing.endedAt);
});
test('legacy stop receipt without a start uses the original measured period',async()=>{
 const f=fixture(null,false,false,{state:'STOPPED',stoppedAtMs:999});await f.save();
 assert.equal(f.writes[0].startedAt,f.input[0].recordedAt);assert.equal(f.writes[0].endedAt,f.input[1].recordedAt);
});
test('invalid durable bounds fail without summary or GPS writes',async()=>{
 const f=fixture(null,false,false,{state:'SAVE_REQUESTED',startedAtMs:2000,stoppedAtMs:1000});
 await assert.rejects(f.save(),/開始・停止/);assert.equal(f.writes.length,0);assert.equal(f.logWrites.length,0);
});

test('automatic stop time is not extended to delayed save time',()=>{
 const module={};const code=ts.transpileModule(fs.readFileSync('src/lib/recordingPeriod.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports',code)(module);
 const measured={startAt:'2026-11-07T00:00:10Z',endAt:'2026-11-07T00:00:40Z'};
 const start=Date.parse('2026-11-07T00:00:00Z');
 const r=module.resolveRecordingSummaryPeriod(measured,null,{state:'STOPPED',startedAtMs:start,stoppedAtMs:start+300000},new Date(start+120000).toISOString());
 assert.equal(Date.parse(r.endAt)-Date.parse(r.startAt),120000);
 assert.throws(()=>module.resolveRecordingSummaryPeriod(measured,null,{state:'STOPPED',startedAtMs:NaN,stoppedAtMs:10}),/開始・停止/);
});


function mapDurationFixture(summary, live = false) {
    const source = fs.readFileSync("src/screens/LocationMapScreen.tsx", "utf8");
    const tree = ts.createSourceFile("map.tsx", source, ts.ScriptTarget.Latest, true);
    const names = ["sessionStartAt", "sessionEndAt", "activityEndTime", "activityDurationSeconds"];
    const expressions = new Map();
    function visit(node) {
        if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree)))
            expressions.set(node.name.getText(tree), node.initializer.getText(tree));
        ts.forEachChild(node, visit);
    }
    visit(tree);
    const logs = [{recordedAt:"2026-11-07T14:48:30.664Z"}, {recordedAt:"2026-11-07T14:49:07.171Z"}];
    const env = {recordingSessionSummary:summary,activeSessionId:"current",editableLocationLogs:logs,isOwnLiveRecordingMap:live,currentDateTime:new Date("2026-11-07T14:49:33.018Z")};
    const code = names.map(name => { assert.ok(expressions.has(name)); return `const ${name} = ${expressions.get(name)};`; }).join("\n");
    return new Function(...Object.keys(env), code+";return {sessionStartAt,sessionEndAt,activityDurationSeconds};")(...Object.values(env));
}
test("actual map expressions use the saved 62-second recording period instead of the 36-second GPS span",()=>{
    const summary={recordingSessionId:"current",startedAt:"2026-11-07T14:48:30.664Z",endedAt:"2026-11-07T14:49:33.018Z"};
    const before=structuredClone(summary), result=mapDurationFixture(summary);
    assert.equal(result.activityDurationSeconds,62);assert.deepEqual(summary,before);
});
test("actual map ignores an old session summary and falls back when a legacy summary is absent",()=>{
    assert.equal(mapDurationFixture(null).activityDurationSeconds,36);
    assert.equal(mapDurationFixture({recordingSessionId:"other",startedAt:"2000-01-01T00:00:00Z",endedAt:"2026-11-07T14:49:33.018Z"}).activityDurationSeconds,36);
});
test("actual live map keeps using current time rather than a saved summary end",()=>{
    assert.equal(mapDurationFixture({recordingSessionId:"current",startedAt:"2026-11-07T14:48:30.664Z",endedAt:"2026-11-07T14:48:31Z"},true).activityDurationSeconds,62);
});

test('save-response retry preserves non-null continuation and auto-stop metadata without options', async () => {
    for (const reason of ['CONTINUATION_TIMEOUT', 'FREE_PLAN_DURATION_LIMIT']) {
        const existing = { id: 'saved', userId: 'A', recordingSessionId: 's',
            startedAt: '2026-10-31T14:00:00Z', endedAt: '2026-10-31T16:00:00Z',
            lastContinuationConfirmedAt: '2026-10-31T15:00:00Z', continuationConfirmationCount: 2,
            autoStoppedAt: '2026-10-31T16:00:00Z', autoStopReason: reason };
        const before = structuredClone(existing), f = fixture(existing, false, false, { state: 'SAVE_REQUESTED' });
        await f.save(); await f.save();
        for (const write of f.writes) for (const key of ['id','startedAt','endedAt','lastContinuationConfirmedAt','continuationConfirmationCount','autoStoppedAt','autoStopReason'])
            assert.equal(write[key], existing[key], `${reason}: ${key}`);
        assert.deepEqual(existing, before); assert.equal(f.logWrites.length, 0);
    }
});

test('actual discard UI disables unknown-save action and forced handler cannot reach queue/server deletion', async () => {
    const source = fs.readFileSync('src/screens/LocationHomeScreen.tsx', 'utf8');
    const tree = ts.createSourceFile('home.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler, disabled;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleDiscardSession') handler = node.initializer.getText(tree);
        if (ts.isJsxOpeningElement(node)) {
            const attrs = node.attributes.properties;
            if (attrs.some(a => a.name?.getText(tree) === 'onPress' && a.initializer?.expression?.getText(tree) === 'handleDiscardSession'))
                disabled = attrs.find(a => a.name?.getText(tree) === 'disabled')?.initializer.expression.getText(tree);
        }
        ts.forEachChild(node, visit);
    }
    visit(tree); assert.ok(handler); assert.ok(disabled);
    const isDisabled = new Function('savingSessionName','saveRequested',`return ${disabled}`);
    assert.equal(isDisabled(false,true),true); assert.equal(isDisabled(false,false),false); assert.equal(isDisabled(true,false),true);
    const calls = [], alerts = [];
    const env = { pendingSessionId:'s', savingSessionName:false, sessionNameMutationRef:{current:false},
        Keyboard:{dismiss(){}}, setSavingSessionName(){}, getCurrentUser:async()=>({userId:'A'}),
        ensureSessionStopped:async()=>{}, pendingRecordingIntervalMs:30000, recordIntervalMs:30000,
        pendingRecordingDistanceMeters:50, recordDistanceMeters:50, pendingSessionShareOwnerValues:[],
        hasSessionSummary:async()=>false,
        recordingLifecycle:{prepareDiscard:async()=>{calls.push('fence');throw Error('SAVE_REQUESTED: discard rejected');}},
        requestLocationQueueSessionDiscard:async()=>{calls.push('queue-delete');},
        client:{mutations:{discardRecordingSession:async()=>{calls.push('server-delete');}}},
        Alert:{alert:(...args)=>alerts.push(args)}, console:{error(){}},
    };
    const code = ts.transpileModule(`const extracted = ${handler};`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const invoke = new Function(...Object.keys(env), code+';return extracted;')(...Object.values(env));
    await invoke(); assert.deepEqual(calls,['fence']); assert.equal(alerts.length,1);
    assert.match(alerts[0][1],/SAVE_REQUESTED/); assert.equal(env.sessionNameMutationRef.current,false);
});
