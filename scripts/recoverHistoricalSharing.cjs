#!/usr/bin/env node
'use strict';
/** One-off recovery for two explicitly whitelisted sandbox sessions.
 * Dry-run by default. Requires AWS SDK v3 installed in the project.
 */
const crypto = require('node:crypto');
const REGION = 'ap-northeast-1';
const SUFFIX = 'yafsunxnuzb6hf2em4dxawtjfe-NONE';
const OWNER = '3704aac8-90e1-70e4-bc50-6acd159a5049';
const GROUP = '05159441-3d9c-4208-8aa4-4cb67a59556f';
const R1 = '57b4eac8-4021-70cd-3f37-423820f9d5c5';
const R2 = '47248aa8-a031-7004-66b8-e41578c805e7';
const OP_TABLE = 'amplify-locationtrackerapp-satouhiroshi-sandbox-0dc5-HistoricalShareOperations6EF4E006-1DL2GB23HMVRL-HistoricalShareOperationTableE93257FD-18S6REPH7BRRJ';
const TABLE = {
  sessions: `RecordingSession-${SUFFIX}`, logs: `LocationLog-${SUFFIX}`,
  grants: `HistoricalShareGrant-${SUFFIX}`, members: `ShareGroupMember-${SUFFIX}`,
  group: `ShareGroup-${SUFFIX}`, operation: OP_TABLE,
};
const CASES = {
  A: { session:'session-1789508764591-byar86l3', count:180, owners:[R1,R2], existing:[R1], missing:R2, status:'COMPLETED', managed:true, opId:'cb3b5597-3149-40e4-b9cc-360efbcce5c9' },
  B: { session:'session-1791759660919-aa946iw8', count:195, owners:[R1], existing:[], missing:R1, status:'FAILED', managed:false, opId:'0ffed59c-f7d2-417e-b30a-fa46f0e4c8e3', failedRecipient:R2 },
};
function assert(value, message) { if(!value) throw new Error(`SAFETY BLOCK: ${message}`); }
function owners(value) {
  assert(Array.isArray(value), 'sharedOwnersが配列ではありません');
  assert(value.every(v => typeof v === 'string' && v.trim() === v && v.length), 'sharedOwnersに不正値');
  assert(new Set(value).size === value.length, 'sharedOwnersに重複');
  return [...value].sort();
}
function same(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
function recordId(c) { return `recording-session:${OWNER}:${c.session}`; }
function grantId(c, recipient) { return `historical-grant#${recordId(c)}#${GROUP}#${recipient}`; }
function createApi() {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({region:REGION}), {marshallOptions:{removeUndefinedValues:true}});
  return {
    get: async (table,key) => (await client.send(new GetCommand({TableName:table, Key:key, ConsistentRead:true}))).Item,
    scan: async(table, filter,values) => {
      let items=[], start;
      do {
        const result = await client.send(new ScanCommand({TableName:table, ConsistentRead:true,
          FilterExpression:filter, ExpressionAttributeValues:values, ExclusiveStartKey:start}));
        items.push(...(result.Items || [])); start=result.LastEvaluatedKey;
      } while(start);
      return items;
    },
    tx: async(items) => client.send(new TransactWriteCommand({TransactItems:items, ClientRequestToken:crypto.randomUUID()})),
  };
}
async function inspect(api, which) {
  const c=CASES[which], id=recordId(c);
  const [session, operation, group, ownerMember, r1Member, r2Member, logs, grants] = await Promise.all([
    api.get(TABLE.sessions,{id}), api.get(TABLE.operation,{recordingSessionRecordId:id}),
    api.get(TABLE.group,{groupId:GROUP}),
    api.get(TABLE.members,{membershipId:`${GROUP}#${OWNER}`}),
    api.get(TABLE.members,{membershipId:`${GROUP}#${R1}`}),
    api.get(TABLE.members,{membershipId:`${GROUP}#${R2}`}),
    api.scan(TABLE.logs,'recordingSessionId = :sid AND userId = :uid',{':sid':c.session,':uid':OWNER}),
    api.scan(TABLE.grants,'recordingSessionRecordId = :id',{':id':id}),
  ]);
  assert(session?.id === id && session?.userId === OWNER && session?.recordingSessionId === c.session, `${which} セッションの所有者/ID不一致`);
  assert(same(owners(session.sharedOwners), [...c.owners].sort()), `${which} セッションの共有先に変更あり`);
  assert(logs.length === c.count && new Set(logs.map(x=>x.id)).size === c.count, `${which} ログ件数/IDが不一致`);
  for(const log of logs) {
    assert(log.userId===OWNER && log.recordingSessionId===c.session && same(owners(log.sharedOwners), [...c.owners].sort()), `${which} ログ ${log.id} の所有者/共有先に不整合`);
  }
  assert(group?.groupId===GROUP && group.isActive===true && group.ownerUserId===OWNER, 'グループの状態が不正');
  assert(ownerMember?.groupId===GROUP && ownerMember.userId===OWNER && ownerMember.role==='OWNER', 'グループ所有者の所属が不正');
  for(const [member,user] of [[r1Member,R1],[r2Member,R2]]) {
    assert(member?.groupId===GROUP && member.userId===user && member.ownerValue===user && member.role==='MEMBER', `${user} の所属/ownerValueが不正`);
  }
  assert(operation?.recordingSessionRecordId===id && operation.ownerUserId===OWNER && operation.operationId===c.opId && operation.status===c.status && operation.grantManaged===c.managed, `${which} 操作台帳が事前確認から変化`);
  assert(grants.length===c.existing.length, `${which} Grant件数が変更`);
  for(const recipient of c.existing) {
    const grant=grants.find(g=>g.grantId===grantId(c,recipient));
    assert(grant?.isActive===true && grant.ownerUserId===OWNER && grant.groupId===GROUP && grant.recipientUserId===recipient && grant.recipientOwnerValue===recipient && grant.recordingSessionRecordId===id, `${which} 既存Grantが不正`);
  }
  if(which==='A') {
    assert(operation.grantId===grantId(c,R1) && operation.recipientUserId===R1 && operation.operationPhase==='GRANT_WRITE_CONFIRMED', 'A 操作履歴不一致');
  } else {
    assert(operation.operationPhase==='INTENT_RECORDED' && operation.requestedEnabled===true && operation.recipientUserId===R2 && operation.grantId===grantId(c,R2), 'B 失敗操作の内容が想定外');
  }
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({which,
    logIds:logs.map(x=>x.id).sort(), sessionOwners:owners(session.sharedOwners),
    operation, grants:grants.sort((a,b)=>a.grantId.localeCompare(b.grantId)),group,
    memberships:[ownerMember,r1Member,r2Member]})).digest('hex').slice(0,20);
  return {which,c,id,session,operation,group,logs,grants,ownerMember,r1Member,r2Member,fingerprint};
}
function transaction(info) {
  const {which,c,id,session,operation,group,ownerMember,r1Member,r2Member}=info;
  const now=new Date().toISOString(), recipient=c.missing, gid=grantId(c,recipient);
  const putGrant={Put:{TableName:TABLE.grants,Item:{
    __typename:'HistoricalShareGrant', grantId:gid, recordingSessionRecordId:id,
    ownerUserId:OWNER,groupId:GROUP,recipientUserId:recipient,
    recipientOwnerValue:recipient,isActive:true,grantedAt:now,createdAt:now,updatedAt:now,
  },ConditionExpression:'attribute_not_exists(grantId)'}};
  const opNames={'#pk':'recordingSessionRecordId','#op':'operationId','#owner':'ownerUserId','#status':'status','#managed':'grantManaged','#phase':'operationPhase','#updated':'updatedAt'};
  const vals={':op':c.opId,':owner':OWNER,':status':c.status,':managed':c.managed,':phase':operation.operationPhase,':now':now};
  let update, condition;
  if(which==='A') {
    update='SET #updated = :now, recoveryGrantAddedAt = :now, recoveryGrantAddedId = :grantId';
    vals[':grantId']=gid;
    condition='attribute_exists(#pk) AND #op = :op AND #owner = :owner AND #status = :status AND #managed = :managed AND #phase = :phase AND attribute_not_exists(recoveryGrantAddedId)';
  } else {
    // Retain the failed operation details in dedicated audit fields; replace the active intent
    // with the legacy-grant recovery operation, marked complete so normal sharing can resume.
    const newId=crypto.randomUUID();
    update='SET #op = :newOp, #status = :complete, #managed = :true, #phase = :confirmed, #updated = :now, completedAt = :now, grantWriteConfirmedAt = :now, recoveredFromOperationId = :op, recoveryStartedAt = :now, recoveryOriginalRecipientUserId = :oldRecipient, recoveryOriginalGrantId = :oldGrant, recoveryOriginalErrorMessage = :oldError, recoveryGrantAddedId = :grantId, recipientUserId = :recipient, grantId = :grantId, requestedEnabled = :true REMOVE errorMessage';
    Object.assign(vals,{':newOp':newId,':complete':'COMPLETED',':true':true,':confirmed':'GRANT_WRITE_CONFIRMED',':oldRecipient':operation.recipientUserId,':oldGrant':operation.grantId,':oldError':operation.errorMessage||'',':grantId':gid,':recipient':recipient});
    condition='attribute_exists(#pk) AND #op = :op AND #owner = :owner AND #status = :status AND #managed = :managed AND #phase = :phase AND recipientUserId = :oldRecipient AND grantId = :oldGrant AND attribute_not_exists(recoveredFromOperationId)';
  }
  const items=[putGrant,{Update:{TableName:TABLE.operation,Key:{recordingSessionRecordId:id},UpdateExpression:update,ConditionExpression:condition,ExpressionAttributeNames:opNames,ExpressionAttributeValues:vals}}];
  // Enforce unchanged projection and membership as of commit, not only preflight.
  items.push({ConditionCheck:{TableName:TABLE.sessions,Key:{id},ConditionExpression:'#owner = :uid AND recordingSessionId = :sid AND sharedOwners = :owners',ExpressionAttributeNames:{'#owner':'userId'},ExpressionAttributeValues:{':uid':OWNER,':sid':c.session,':owners':session.sharedOwners}}});
  items.push({ConditionCheck:{TableName:TABLE.group,Key:{groupId:GROUP},ConditionExpression:'isActive = :active AND ownerUserId = :owner',ExpressionAttributeValues:{':active':true,':owner':OWNER}}});
  for(const member of [ownerMember,r1Member,r2Member]) {
    items.push({ConditionCheck:{TableName:TABLE.members,Key:{membershipId:member.membershipId},ConditionExpression:'groupId = :gid AND userId = :user AND ownerValue = :value AND #role = :role',ExpressionAttributeNames:{'#role':'role'},ExpressionAttributeValues:{':gid':GROUP,':user':member.userId,':value':member.ownerValue,':role':member.role}}});
  }
  return items;
}
async function main() {
  const args=process.argv.slice(2), which=args[0];
  assert(which==='A'||which==='B', '使い方: node scripts/recoverHistoricalSharing.cjs A|B [--apply --fingerprint <DRY_RUN_FINGERPRINT>]');
  const apply=args.includes('--apply');
  assert(!args.includes('--apply') || (args.length===4 && args[1]==='--apply' && args[2]==='--fingerprint' && /^[a-f0-9]{20}$/.test(args[3])), '書き込みには --apply --fingerprint <20桁> を指定');
  assert(!apply || process.env.HISTORICAL_RECOVERY_APPROVED === 'YES', '書き込みには HISTORICAL_RECOVERY_APPROVED=YES が必要');
  const api=createApi(), before=await inspect(api,which);
  console.log(JSON.stringify({mode:apply?'APPLY':'DRY_RUN',which,session:before.c.session,logs:before.logs.length,owners:before.c.owners,existingGrants:before.grants.length,grantToAdd:grantId(before.c,before.c.missing),operationStatus:before.operation.status,fingerprint:before.fingerprint},null,2));
  if(!apply) { console.log(`\n書き込みなし。承認後: HISTORICAL_RECOVERY_APPROVED=YES node scripts/recoverHistoricalSharing.cjs ${which} --apply --fingerprint ${before.fingerprint}`);return; }
  assert(args[3]===before.fingerprint,'直前のdry-runからデータが変更されました。再確認してください');
  await api.tx(transaction(before));
  // verify preservation and new grant; no attempt to roll back a committed transaction
  const [newGrant, afterOp,afterSession,afterGrants,afterLogs]=await Promise.all([
    api.get(TABLE.grants,{grantId:grantId(before.c,before.c.missing)}),
    api.get(TABLE.operation,{recordingSessionRecordId:before.id}),
    api.get(TABLE.sessions,{id:before.id}),
    api.scan(TABLE.grants,'recordingSessionRecordId = :id',{':id':before.id}),
    api.scan(TABLE.logs,'recordingSessionId = :sid AND userId = :uid',{':sid':before.c.session,':uid':OWNER}),
  ]);
  assert(newGrant?.isActive===true && newGrant.recipientOwnerValue===before.c.missing, '書き込み後Grant検証エラー');
  assert(afterOp?.status==='COMPLETED' && afterOp.grantManaged===true, '書き込み後Operation検証エラー');
  assert(same(owners(afterSession?.sharedOwners),[...before.c.owners].sort()),'書き込み後共有先に変更');
  assert(afterGrants.length===before.c.owners.length && afterGrants.every(g=>g.isActive===true && before.c.owners.includes(g.recipientOwnerValue)), '書き込み後Grant全件の整合性エラー');
  assert(afterLogs.length===before.c.count && afterLogs.every(log=>log.userId===OWNER && same(owners(log.sharedOwners),[...before.c.owners].sort())), '書き込み後ログ全件の整合性エラー');
  console.log(`SUCCESS ${which}: Grant補完・Operation整合を確認。LocationLog/RecordingSessionは更新していません。`);
}
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={CASES,recordId,grantId,owners,transaction,inspect};
