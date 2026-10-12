// Offline tests of the actual diagnoseHistoricalShareRecoveryAdmin() function.
// No AWS clients, credentials, network, or DynamoDB mutations are used.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');

const sourcePath = path.resolve(process.argv[2] || 'amplify/functions/share-group-api/handler.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'diagnoseHistoricalShareRecoveryAdmin');
if (!fn) throw new Error('diagnoseHistoricalShareRecoveryAdmin not found');
const js = ts.transpileModule(`${fn.getText(ast)}\nglobalThis.testDiagnosis = diagnoseHistoricalShareRecoveryAdmin;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

const owner = '3704aac8-90e1-70e4-bc50-6acd159a5049';
const sid = 'session-1789508764591-byar86l3';
const recordId = `recording-session:${owner}:${sid}`;
const recipient = '57b4eac8-4021-70cd-3f37-423820f9d5c5';
const group = '05159441-3d9c-4208-8aa4-4cb67a59556f';
const grantId = ['historical-grant', recordId, group, recipient].join('#');
const equals = (a, b) => JSON.stringify([...(a||[])].sort()) === JSON.stringify([...(b||[])].sort());
const makeGrant = (changes = {}) => ({grantId, recordingSessionRecordId:recordId, ownerUserId:owner, groupId:group, recipientUserId:recipient, recipientOwnerValue:recipient, isActive:true, ...changes});
const makeOperation = (changes = {}) => ({operationId:'op-test', status:'FAILED', ownerUserId:owner, recordingSessionRecordId:recordId, grantManaged:true, operationPhase:'GRANT_WRITE_CONFIRMED', grantWriteConfirmedAt:'2026-10-12T00:00:00Z', intentRecordedAt:'2026-10-12T00:00:00Z', grantId, groupId:group, recipientUserId:recipient, requestedEnabled:true, ...changes});
function fixture({operation = null, grants = [], actualOwners = [recipient], logOwners = [recipient], logCount = 180} = {}) {
  const logs = Array.from({length:logCount}, (_, i) => ({id:`log-${i}`, sharedOwners:logOwners}));
  const projectedOwners = [...new Set(grants.filter(g=>g.isActive).map(g=>g.recipientOwnerValue))];
  const mismatch = logs.filter(l=>!equals(l.sharedOwners,projectedOwners)).map(l=>l.id);
  const projection = {recordingSessionRecordId:recordId, recordingSessionId:sid, grants, logs,
    sharedOwners:projectedOwners, recordingSessionNeedsUpdate:!equals(actualOwners,projectedOwners),
    locationLogIdsNeedingUpdate:mismatch};
  const context = {
    console: {info:()=>{}},
    assertHistoricalMigrationAdmin:()=>owner,
    getOwnedRecordingSession:async()=>({id:recordId, userId:owner, recordingSessionId:sid}),
    getHistoricalShareOperation:async()=>operation,
    prepareHistoricalShareProjection:async()=>projection,
    client:{models:{RecordingSession:{get:async()=>({data:{id:recordId,userId:owner,recordingSessionId:sid,sharedOwners:actualOwners},errors:[]})}}},
    makeHistoricalGrantId:(a,b,c)=>['historical-grant',a,b,c].join('#'),
    areSharedOwnersEqual:equals,
  };
  vm.runInNewContext(js, context, {filename:sourcePath, timeout:3000});
  return context.testDiagnosis({arguments:{ownerUserId:owner,recordingSessionId:sid}});
}
const cases = [
 ['no operation, no grant','NO_OPERATION',{}],
 ['orphan grant','BLOCKED',{grants:[makeGrant()]}],
 ['pending, no grant','IN_PROGRESS',{operation:makeOperation({status:'PENDING',grantManaged:false,operationPhase:'INTENT_RECORDED',grantWriteConfirmedAt:undefined})}],
 ['failed before commit','PRE_COMMIT_FAILURE',{operation:makeOperation({grantManaged:false,operationPhase:'INTENT_RECORDED',grantWriteConfirmedAt:undefined})}],
 ['precommit missing intent','BLOCKED',{operation:makeOperation({grantManaged:false,operationPhase:undefined,grantWriteConfirmedAt:undefined,intentRecordedAt:undefined,grantId:undefined})}],
 ['precommit mismatched owner','BLOCKED',{operation:makeOperation({grantManaged:false,operationPhase:'INTENT_RECORDED',grantWriteConfirmedAt:undefined,ownerUserId:'wrong'})}],
 ['precommit unexpectedly has grant','BLOCKED',{operation:makeOperation({grantManaged:false,operationPhase:'INTENT_RECORDED',grantWriteConfirmedAt:undefined}),grants:[makeGrant()]}],
 ['precommit log sharedOwners differs','BLOCKED',{operation:makeOperation({grantManaged:false,operationPhase:'INTENT_RECORDED',grantWriteConfirmedAt:undefined}),logOwners:[]}],
 ['failed after commit, consistent','REPAIR_CANDIDATE',{operation:makeOperation(),grants:[makeGrant()]}],
 ['failed after commit, bad grant recipient','BLOCKED',{operation:makeOperation(),grants:[makeGrant({recipientOwnerValue:'wrong'})]}],
 ['failed after commit, one log differs','BLOCKED',{operation:makeOperation(),grants:[makeGrant()],logOwners:[]}],
 ['failed after commit, grant missing','BLOCKED',{operation:makeOperation()}],
 ['completed, valid','COMPLETED',{operation:makeOperation({status:'COMPLETED'}),grants:[makeGrant()]}],
 ['completed without managed grant','BLOCKED',{operation:makeOperation({status:'COMPLETED',grantManaged:false,operationPhase:'INTENT_RECORDED',grantWriteConfirmedAt:undefined})}],
 ['unknown status','BLOCKED',{operation:makeOperation({status:'UNKNOWN'}),grants:[makeGrant()]}],
];
(async()=>{
  let failures=0;
  for (const [label, expected, input] of cases) {
    try {
      const result=await fixture(input);
      assert.equal(result.diagnosisCode,expected);
      assert.equal(result.safeToExecuteRecovery,false);
      console.log(`PASS ${label}: ${result.diagnosisCode}`);
    } catch(e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
  }
  console.log(`\n${cases.length-failures}/${cases.length} passed`);
  if(failures) process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
