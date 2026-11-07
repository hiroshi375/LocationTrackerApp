/** Opt-in AWS integration test. Only newly created, random-prefix tables are reachable.
 * Executes unmodified backend modules against REAL DynamoDB (no SDK mocks).
 * Does not deploy Lambda/AppSync or touch production/sandbox data.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const DDB = require('@aws-sdk/client-dynamodb');
const DOC = require('@aws-sdk/lib-dynamodb');

async function main() {
  if (process.argv[2] !== '--execute-isolated' || !/^\d{12}$/.test(process.argv[3] ?? ''))
    throw Error('Usage: node scripts/diagnostics/verifyRecordingLifecycleIsolated.cjs --execute-isolated EXPECTED_ACCOUNT');
  const identity = JSON.parse(execFileSync('/opt/homebrew/bin/aws', ['sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8' }));
  assert.equal(identity.Account, process.argv[3], 'Unexpected AWS account');
  assert.ok(!process.env.AWS_ENDPOINT_URL && !process.env.AWS_ENDPOINT_URL_DYNAMODB, 'Endpoint overrides forbidden');
  process.env.AWS_REGION = 'ap-northeast-1';
  const runId = `aclog-lifecycle-it-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = path.resolve('.amplify/login-recording-incident-20261103', runId);
  fs.mkdirSync(dir, { recursive: true });
  const schema = {
    sessions: ['id'], logs: ['id'], ops: ['recordingSessionRecordId'],
    grants: ['grantId'], index: ['sessionKey', 'logId'], deletion: ['userId'],
  };
  const names = Object.fromEntries(Object.keys(schema).map(k => [k, `${runId}-${k}`]));
  const allowed = new Set(Object.values(names));
  const created = [], requests = {}, results = [], sources = {};
  const report = { runId, region: process.env.AWS_REGION, account: identity.Account, startedAt: new Date().toISOString(),
    boundary: 'Real DynamoDB; backend modules invoked directly on Mac; not Lambda/AppSync/Cognito/device E2E',
    names, created, requests, results, sourceSHA256: sources, cleanup: {} };
  const persist = () => fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  persist();
  function guard(client) {
    client.middlewareStack.add(next => async args => {
      const input = args.input;
      const targets = [input.TableName,
        ...Object.keys(input.RequestItems ?? {}),
        ...(input.TransactItems ?? []).map(x => (x.Put ?? x.Delete ?? x.Update ?? x.ConditionCheck ?? {}).TableName),
      ].filter(Boolean);
      assert.ok(targets.length, 'Command without a scoped table rejected');
      for (const table of targets) assert.ok(allowed.has(table), `Non-isolated table rejected: ${table}`);
      requests.total = (requests.total ?? 0) + 1;
      return next(args);
    }, { step: 'initialize', name: 'isolatedTablesOnly', priority: 'high' });
  }
  const raw = new DDB.DynamoDBClient({ region: process.env.AWS_REGION });
  guard(raw);
  const seed = DOC.DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  const env = {
    HISTORICAL_RECORDING_SESSION_TABLE_NAME: names.sessions,
    HISTORICAL_LOCATION_LOG_TABLE_NAME: names.logs,
    HISTORICAL_SHARE_OPERATION_TABLE_NAME: names.ops,
    HISTORICAL_SHARE_GRANT_TABLE_NAME: names.grants,
    SESSION_LOG_INDEX_TABLE_NAME: names.index,
    ACCOUNT_DELETION_TABLE_NAME: names.deletion,
  };
  // Unused table names fail closed rather than inheriting any shell configuration.
  for (const key of ['GROUP_ACCESS_OPERATION_TABLE_NAME', 'SHARE_GROUP_TABLE_NAME', 'SHARE_GROUP_MEMBER_TABLE_NAME']) delete process.env[key];
  Object.assign(process.env, env);
  const cache = {};
  function load(name) {
    if (!name.startsWith('./')) return require(name);
    if (cache[name]) return cache[name];
    const filename = path.resolve('amplify/functions/share-group-api', name.slice(2) + '.ts');
    const source = fs.readFileSync(filename, 'utf8');
    sources[path.relative(process.cwd(), filename)] = createHash('sha256').update(source).digest('hex');
    const out = {}; cache[name] = out;
    new Function('exports', 'require', ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText)(out, load);
    return out;
  }
  async function test(name, fn) {
    const start = Date.now();
    try { const detail = await fn(); results.push({ name, status: 'PASS', ms: Date.now() - start, detail }); console.log('PASS', name); }
    catch (e) { results.push({ name, status: 'FAIL', ms: Date.now() - start, error: String(e.stack ?? e) }); throw e; }
    finally { persist(); }
  }
  const put = (table, Item) => seed.send(new DOC.PutCommand({ TableName: table, Item }));
  const get = async (table, Key) => (await seed.send(new DOC.GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
  const count = async (table, predicate) => {
    let cursor, rows = [];
    do { const p = await seed.send(new DOC.ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: cursor })); rows.push(...(p.Items ?? [])); cursor = p.LastEvaluatedKey; } while (cursor);
    return rows.filter(predicate);
  };
  const user = 'synthetic-owner', other = 'synthetic-other';
  const summary = (s, u = user, id = `recording-session:${u}:${s}`) => ({ id, userId: u, recordingSessionId: s,
    recordingSessionName: `IT ${s}`, owner: `${u}::test`, durationSeconds: 60, totalDistanceMeters: 12 });
  const point = (s, suffix, u = user) => ({ id: `${u}:${s}:${suffix}`, userId: u, recordingSessionId: s,
    latitude: 35, longitude: 139, accuracy: 8, recordedAt: '2026-11-03T00:00:00.000Z', source: 'background' });
  let store;
  try {
    for (const [type, keys] of Object.entries(schema)) {
      await raw.send(new DDB.CreateTableCommand({ TableName: names[type], BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: keys.map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
        KeySchema: keys.map((AttributeName, i) => ({ AttributeName, KeyType: i ? 'RANGE' : 'HASH' })),
        Tags: [{ Key: 'Purpose', Value: 'isolated-recording-lifecycle-regression' }, { Key: 'RunId', Value: runId }],
      }));
      created.push(names[type]); persist();
      await DDB.waitUntilTableExists({ client: raw, maxWaitTime: 60, minDelay: 1, maxDelay: 3 }, { TableName: names[type] });
    }
    store = load('./groupAccessStore'); guard(store.accessDb);
    const legacy = load('./legacyRecordingWrite'), discard = load('./discardRecordingSession'), ingest = load('./locationLogIngest');
    const finish = async s => {
      for (let i = 0; i < 20; i++) if (await discard.discardRecordingSessionBatch(user, s)) return;
      throw Error('Discard did not complete within bound');
    };
    await put(names.index, { sessionKey: '__CONTROL__', logId: 'READY', version: 1, legacySharingVerified: true });
    const sentinel = { id: 'unrelated-saved-record', userId: other, owner: other, recordingSessionId: 'unrelated', totalDistanceMeters: 321 };
    const queued = { ...point('unrelated', 'pending', other), owner: other, memo: 'synthetic preservation sentinel' };
    await put(names.sessions, sentinel); await put(names.logs, queued);
    await test('Guard rejects any non-isolated table before network I/O', async () => {
      const before = requests.total;
      await assert.rejects(store.accessDb.send(new DOC.GetCommand({ TableName: 'FORBIDDEN-NON-ISOLATED', Key: { id: 'x' } })), /Non-isolated/);
      assert.equal(requests.total, before);
    });
    await test('Old-client create, duplicate resend, and new ingest resend preserve one point', async () => {
      const s = 'legacy-save'; const p = point(s, 'p');
      await legacy.createLegacyLocationLog(user, 'test', p);
      await assert.rejects(legacy.createLegacyLocationLog(user, 'test', p), /already exists/);
      assert.equal((await ingest.ingestLocationLog(user, 'test', p)).created, false);
      await legacy.createLegacyRecordingSession(user, 'test', summary(s));
      await assert.rejects(legacy.createLegacyRecordingSession(user, 'test', summary(s)), /already exists/);
      // Valid late points from the same owner remain uploadable after save.
      await legacy.createLegacyLocationLog(user, 'test', point(s, 'late-pending'));
      assert.equal((await count(names.logs, r => r.recordingSessionId === s)).length, 2);
    });
    await test('Saved canonical and historical noncanonical summaries cannot be discarded', async () => {
      for (const [s, id] of [['legacy-save', undefined], ['historical-saved', 'historical-random-id']]) {
        if (id) { await put(names.sessions, summary(s, user, id)); await legacy.createLegacyLocationLog(user, 'test', point(s, 'p')); }
        const before = await count(names.logs, r => r.recordingSessionId === s);
        await assert.rejects(finish(s), /SAVED_SESSION_PROTECTED/);
        assert.deepEqual(await count(names.logs, r => r.recordingSessionId === s), before);
        assert.equal(await get(names.ops, { recordingSessionRecordId: `recording-session:${user}:${s}` }), undefined);
      }
    });
    await test('Normal unsaved multi-page discard removes own points/grant, keeps other owner, blocks stale replay', async () => {
      const s = 'normal-unsaved';
      for (let i = 0; i < 25; i++) await legacy.createLegacyLocationLog(user, 'test', point(s, `p${i}`));
      await legacy.createLegacyLocationLog(other, 'test', point(s, 'other', other));
      const id = `recording-session:${user}:${s}`;
      await put(names.grants, { grantId: 'orphan-grant', recordingSessionRecordId: id, ownerUserId: user });
      await finish(s); await finish(s);
      assert.equal((await count(names.logs, r => r.recordingSessionId === s && r.userId === user)).length, 0);
      assert.equal((await count(names.logs, r => r.recordingSessionId === s && r.userId === other)).length, 1);
      assert.equal(await get(names.grants, { grantId: 'orphan-grant' }), undefined);
      await assert.rejects(legacy.createLegacyRecordingSession(user, 'test', summary(s)));
      await assert.rejects(legacy.createLegacyLocationLog(user, 'test', point(s, 'stale-replay')), /SESSION_DISCARDED/);
    });
    await test('Old in-progress discard with no lifecycle key resumes and can be retried', async () => {
      const s = 'old-in-progress'; await legacy.createLegacyLocationLog(user, 'test', point(s, 'p'));
      await put(names.ops, { recordingSessionRecordId: `recording-session:${user}:${s}`, ownerUserId: user,
        recordingSessionId: s, operationId: 'old-generation', discardOperation: true, status: 'DISCARDING' });
      await finish(s); await finish(s);
      assert.equal((await count(names.logs, r => r.recordingSessionId === s)).length, 0);
    });
    await test('Legacy partial discard with saved summary blocks further deletion', async () => {
      const s = 'old-partial-saved'; await put(names.sessions, summary(s)); await put(names.logs, { ...point(s, 'p'), owner: user });
      await put(names.ops, { recordingSessionRecordId: `recording-session:${user}:${s}`, ownerUserId: user,
        recordingSessionId: s, operationId: 'old-generation', discardOperation: true, status: 'DISCARDING' });
      await assert.rejects(finish(s), /SAVED_SESSION_PROTECTED/);
      assert.ok(await get(names.logs, { id: point(s, 'p').id }));
      assert.equal((await get(names.ops, { recordingSessionRecordId: `recording-session:${user}:${s}` })).status, 'DISCARDING');
    });
    await test('Forced stale-read interleavings: both save-wins and discard-wins are atomic', async () => {
      const outcomes = [];
      for (const winner of ['save', 'discard']) {
        const s = `forced-${winner}`;
        await legacy.createLegacyLocationLog(user, 'test', point(s, 'p'));
        let entered, release;
        const enteredPromise = new Promise(resolve => { entered = resolve; });
        const releasePromise = new Promise(resolve => { release = resolve; });
        const middleware = `hold-${winner}`;
        let held = false;
        store.accessDb.middlewareStack.add(next => async args => {
          const puts = (args.input.TransactItems ?? []).filter(x => x.Put).map(x => x.Put);
          const selected = winner === 'discard'
            ? puts.some(x => x.TableName === names.sessions && x.Item.id === summary(s).id)
            : puts.some(x => x.TableName === names.ops && x.Item.sessionLifecycleState === 'DISCARDING');
          if (!held && selected) { held = true; entered(); await releasePromise; }
          return next(args);
        }, { step: 'initialize', name: middleware, priority: 'high' });
        const loser = (winner === 'discard'
          ? legacy.createLegacyRecordingSession(user, 'test', summary(s)) : finish(s))
          .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
        let timeout;
        try {
          await Promise.race([enteredPromise, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Error('Expected transaction was not reached')), 15000);
          })]);
          clearTimeout(timeout);
          if (winner === 'discard') await finish(s);
          else await legacy.createLegacyRecordingSession(user, 'test', summary(s));
          release();
          const result = await loser;
          assert.equal(result.status, 'rejected');
          assert.match(String(result.error), winner === 'discard' ? /SESSION_DISCARDED/ : /SAVED_SESSION_PROTECTED/);
          const saved = await get(names.sessions, { id: summary(s).id });
          assert.equal(!!saved, winner === 'save');
          assert.equal((await count(names.logs, r => r.recordingSessionId === s)).length, winner === 'save' ? 1 : 0);
          outcomes.push({ winner, loserError: String(result.error) });
        } finally {
          clearTimeout(timeout); release(); await loser;
          store.accessDb.middlewareStack.remove(middleware);
        }
      }
      return outcomes;
    });
    await test('Concurrent save versus discard: 20 independent rounds preserve exclusive terminal outcome', async () => {
      let saved = 0, discarded = 0;
      for (let i = 0; i < 20; i++) {
        const s = `race-${i}`; await legacy.createLegacyLocationLog(user, 'test', point(s, 'p'));
        const operations = [() => legacy.createLegacyRecordingSession(user, 'test', summary(s)), () => finish(s)];
        if (i % 2) operations.reverse();
        const outcome = await Promise.allSettled(operations.map(fn => fn()));
        const record = await get(names.sessions, { id: summary(s).id });
        const op = await get(names.ops, { recordingSessionRecordId: summary(s).id });
        const fence = await get(names.ops, { recordingSessionRecordId: `lifecycle:${JSON.stringify([user,s])}` });
        const points = await count(names.logs, r => r.recordingSessionId === s);
        assert.ok(record || op?.status === 'DISCARDED', 'Neither contender completed');
        assert.ok(!(record && op?.discardOperation), 'Saved record and discard coexist');
        assert.equal(outcome.filter(r => r.status === 'fulfilled').length, 1);
        if (record) { saved++; assert.equal(points.length, 1); assert.equal(fence.sessionLifecycleState, 'SAVED'); }
        else { discarded++; assert.equal(points.length, 0); assert.equal(fence.sessionLifecycleState, 'DISCARDED'); }
      }
      return { rounds: 20, saved, discarded };
    });
    await test('Concurrent old-client pending upload versus discard: 8 rounds leave no orphan points', async () => {
      for (let i = 0; i < 8; i++) {
        const s = `upload-race-${i}`;
        const result = await Promise.allSettled([legacy.createLegacyLocationLog(user, 'test', point(s, 'pending')), finish(s)]);
        if (result[1].status === 'rejected') throw result[1].reason;
        await finish(s);
        assert.equal((await count(names.logs, r => r.recordingSessionId === s)).length, 0);
        assert.equal((await count(names.index, r => r.sessionKey === JSON.stringify([user,s]))).length, 0);
      }
      return { rounds: 8 };
    });
    await test('Wrong-owner writes/deletes fail; explicit owner history delete still works', async () => {
      await assert.rejects(legacy.createLegacyLocationLog(other, 'test', point('ownership', 'p')));
      const s = 'explicit-delete'; await legacy.createLegacyRecordingSession(user, 'test', summary(s));
      await assert.rejects(legacy.deleteLegacyRecordingSession(other, { id: summary(s).id }), /NEEDS_REPAIR/);
      assert.equal((await legacy.deleteLegacyRecordingSession(user, { id: summary(s).id })).id, summary(s).id);
      assert.equal(await get(names.sessions, { id: summary(s).id }), undefined);
    });
    await test('Account-deleting and index-not-ready guards leave all data unchanged', async () => {
      const s = 'account-guard'; await legacy.createLegacyLocationLog(user, 'test', point(s, 'p'));
      await put(names.deletion, { userId: user }); await assert.rejects(finish(s), /ACCOUNT_DELETING/);
      await seed.send(new DOC.DeleteCommand({ TableName: names.deletion, Key: { userId: user } }));
      await put(names.index, { sessionKey: '__CONTROL__', logId: 'READY', version: 0 });
      await assert.rejects(finish(s), /索引の準備/);
      assert.ok(await get(names.logs, { id: point(s, 'p').id }));
      await put(names.index, { sessionKey: '__CONTROL__', logId: 'READY', version: 1, legacySharingVerified: true });
    });
    await test('Unrelated saved and synthetic pending data remain byte-for-byte unchanged', async () => {
      assert.deepEqual(await get(names.sessions, { id: sentinel.id }), sentinel);
      assert.deepEqual(await get(names.logs, { id: queued.id }), queued);
    });
    report.status = 'PASS';
  } catch (e) { report.status = 'FAIL'; report.error = String(e.stack ?? e); process.exitCode = 1; }
  finally {
    // Remove only tables this invocation successfully created, even on test failure.
    for (const table of created.slice().reverse()) {
      try {
        await raw.send(new DDB.DeleteTableCommand({ TableName: table }));
        await DDB.waitUntilTableNotExists({ client: raw, maxWaitTime: 60, minDelay: 1, maxDelay: 3 }, { TableName: table });
        report.cleanup[table] = 'DELETED';
      } catch (e) { report.cleanup[table] = String(e); process.exitCode = 1; }
      persist();
    }
    report.finishedAt = new Date().toISOString(); persist();
    store?.accessDb.destroy(); raw.destroy();
    console.log(JSON.stringify({ status: report.status, passed: results.filter(x => x.status === 'PASS').length,
      cleanup: Object.values(report.cleanup).every(x => x === 'DELETED'), report: path.join(dir, 'result.json') }));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
