/** Offline tests of the REAL commitHistoricalMigrationGrant implementation.
 * No AWS client is instantiated, no network I/O, no DynamoDB changes.
 * Uses local `typescript` to transpile the source, then mocks AWS SDK.
 * The in-memory evaluator handles the exact condition-expression subset in the tested transaction.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const file = path.resolve(process.argv[2] || 'amplify/functions/share-group-api/historicalShareOperation.ts');
if (!fs.existsSync(file)) throw new Error(`Source file not found: ${file}`);
const source = fs.readFileSync(file, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const transactionCalls = [];
let store;
class FakeCommand { constructor(input) { this.input = input; } }
class TransactWriteCommand extends FakeCommand {}
class UpdateCommand extends FakeCommand {}
class GetCommand extends FakeCommand {}
class PutCommand extends FakeCommand {}
const clone = x => structuredClone(x);
const ident = (s, names) => names?.[s] ?? s.replace(/^#/, '');
function conditionMatches(expr, names, values, current) {
  // Fail closed for unfamiliar syntax; never silently skip a condition.
  return expr.split(/\s+AND\s+/).every(term => {
    term = term.trim();
    let m = /^attribute_not_exists\((#[A-Za-z0-9_]+)\)$/.exec(term);
    if (m) return current == null || !Object.hasOwn(current, ident(m[1], names));
    m = /^(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)$/.exec(term);
    if (m) return current != null && current[ident(m[1], names)] === values[m[2]];
    throw new Error(`Unknown condition syntax (fail closed): ${term}`);
  });
}
function transact(input) {
  transactionCalls.push(clone(input));
  assert.equal(input.TransactItems.length, 2, 'Unexpected transaction shape');
  const draft = clone(store);
  for (const item of input.TransactItems) {
    if (item.Put) {
      const p = item.Put;
      assert.equal(p.TableName, 'MockGrantTable');
      const current = draft.grants[p.Item.grantId];
      if (!conditionMatches(p.ConditionExpression, p.ExpressionAttributeNames, p.ExpressionAttributeValues, current)) {
        const e = new Error('Put conditional failure'); e.name = 'TransactionCanceledException'; throw e;
      }
      draft.grants[p.Item.grantId] = clone(p.Item);
    } else if (item.Update) {
      const u = item.Update;
      assert.equal(u.TableName, 'MockOperationTable');
      const current = draft.operations[u.Key.recordingSessionRecordId];
      if (!conditionMatches(u.ConditionExpression, u.ExpressionAttributeNames, u.ExpressionAttributeValues, current)) {
        const e = new Error('Update conditional failure'); e.name = 'TransactionCanceledException'; throw e;
      }
      const set = u.UpdateExpression;
      assert.ok(set.startsWith('SET '));
      for (const assignment of set.slice(4).split(/\s*,\s*/)) {
        const m = /^(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)$/.exec(assignment);
        if (!m) throw new Error(`Unknown update syntax: ${assignment}`);
        current[ident(m[1], u.ExpressionAttributeNames)] = u.ExpressionAttributeValues[m[2]];
      }
    } else throw new Error('Unexpected transaction item');
  }
  store = draft; // Atomic commit only after ALL conditions pass.
}
const db = {send: async command => {
  if (command instanceof TransactWriteCommand) return transact(command.input);
  throw new Error('Unexpected AWS command: ' + command.constructor.name);
}};
const fakeRequire = name => {
  if (name === 'node:crypto') return { randomUUID: () => 'mock-uuid' };
  if (name === '@aws-sdk/client-dynamodb') return { DynamoDBClient: class {} };
  if (name === '@aws-sdk/lib-dynamodb') return {
    DynamoDBDocumentClient: {from: () => db}, PutCommand, UpdateCommand, GetCommand, TransactWriteCommand,
  };
  throw new Error('Disallowed import: ' + name);
};
const exportsObj = {};
vm.runInNewContext(transpiled, {require: fakeRequire, exports: exportsObj, process: {
  env: { HISTORICAL_SHARE_OPERATION_TABLE_NAME: 'MockOperationTable', HISTORICAL_SHARE_GRANT_TABLE_NAME: 'MockGrantTable' }
}, console, Date, Error}, { filename: file, timeout: 1000 });
const commit = exportsObj.commitHistoricalMigrationGrant;
assert.equal(typeof commit, 'function', 'commitHistoricalMigrationGrant not found');
const ownerUserId = 'owner', recordingSessionRecordId = 'session-record', groupId = 'group', recipientUserId = 'recipient';
const grantId = ['historical-grant', recordingSessionRecordId, groupId, recipientUserId].join('#');
const operation = { recordingSessionRecordId, operationId: 'op-1', ownerUserId, status: 'PENDING', grantManaged: false,
  operationPhase: 'INTENT_RECORDED', grantId, groupId, recipientUserId, requestedEnabled: true, intentRecordedAt: '2026-10-12T00:00:00Z' };
const input = { grantId, groupId, recipientUserId, recipientOwnerValue: 'recipient-owner' };
const fresh = () => ({grants:{}, operations:{[recordingSessionRecordId]:clone(operation)}});
async function test(name, change, expectedSuccess=false) {
  store = fresh(); transactionCalls.length=0;
  change?.(store);
  const before = clone(store);
  let error;
  try { await commit(clone(operation), clone(input)); } catch(e){error=e;}
  if (expectedSuccess) {
    assert.equal(error, undefined, String(error));
    assert.equal(store.grants[grantId].recipientOwnerValue, input.recipientOwnerValue);
    assert.equal(store.operations[recordingSessionRecordId].grantManaged, true);
    assert.equal(store.operations[recordingSessionRecordId].operationPhase, 'GRANT_WRITE_CONFIRMED');
    assert.ok(store.operations[recordingSessionRecordId].grantWriteConfirmedAt);
  } else {
    assert.ok(error, `${name}: expected rejection`);
    assert.deepEqual(store, before, `${name}: partial write detected`);
  }
  if (name !== 'invalid input grant id') assert.equal(transactionCalls.length, 1);
  process.stdout.write(`PASS ${name}${expectedSuccess ? ' (commit)' : ' (rejected, unchanged)'}\n`);
}
(async () => {
  await test('valid transaction', null, true);
  await test('duplicate grant', s=>{s.grants[grantId]={grantId, existing: true};});
  await test('wrong operationId', s=>{s.operations[recordingSessionRecordId].operationId='other-op';});
  await test('wrong ownerUserId', s=>{s.operations[recordingSessionRecordId].ownerUserId='other-owner';});
  await test('APPLYING operation', s=>{s.operations[recordingSessionRecordId].status='APPLYING';});
  await test('FAILED operation', s=>{s.operations[recordingSessionRecordId].status='FAILED';});
  await test('already managed', s=>{s.operations[recordingSessionRecordId].grantManaged=true;});
  await test('missing intent', s=>{s.operations[recordingSessionRecordId].operationPhase=undefined;});
  await test('wrong grantId in intent', s=>{s.operations[recordingSessionRecordId].grantId='bad';});
  await test('wrong groupId in intent', s=>{s.operations[recordingSessionRecordId].groupId='bad';});
  await test('wrong recipient in intent', s=>{s.operations[recordingSessionRecordId].recipientUserId='bad';});
  await test('disable requested', s=>{s.operations[recordingSessionRecordId].requestedEnabled=false;});
  await test('operation missing', s=>{delete s.operations[recordingSessionRecordId];});
  transactionCalls.length=0;
  const before=clone(fresh()); store=clone(before);
  await assert.rejects(()=>commit(clone(operation), {...input,grantId:'bad'}));
  assert.deepEqual(store,before); assert.equal(transactionCalls.length,0);
  process.stdout.write('PASS invalid input grant id (rejected before transaction)\n');
  store=fresh(); transactionCalls.length=0;
  await Promise.allSettled([commit(clone(operation),clone(input)),commit(clone(operation),clone(input))]).then(results=>{
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    assert.equal(Object.keys(store.grants).length,1);
    assert.equal(store.operations[recordingSessionRecordId].grantManaged,true);
    process.stdout.write('PASS concurrent duplicate commits (one winner)\n');
  });
  process.stdout.write('\n15/15 passed (offline transactional simulation)\n');
})().catch(e=>{console.error('FAIL',e);process.exitCode=1;});
