'use strict';
const assert=require('node:assert/strict');
const {CASES,recordId,grantId,owners,transaction,inspect}=require('./recoverHistoricalSharing.cjs');
const GROUP='05159441-3d9c-4208-8aa4-4cb67a59556f';
const OWNER='3704aac8-90e1-70e4-bc50-6acd159a5049';
const R1='57b4eac8-4021-70cd-3f37-423820f9d5c5';
const R2='47248aa8-a031-7004-66b8-e41578c805e7';
function fixture(which) {
 const c=CASES[which],id=recordId(c), now='2026-10-12T11:05:14.549Z';
 const operation={recordingSessionRecordId:id,ownerUserId:OWNER,operationId:c.opId,status:c.status,grantManaged:c.managed,operationPhase:which==='A'?'GRANT_WRITE_CONFIRMED':'INTENT_RECORDED', grantId:which==='A'?grantId(c,R1):grantId(c,R2), recipientUserId:which==='A'?R1:R2,requestedEnabled:true,errorMessage:which==='B'?'RecordingSessionに未移行の共有権限があります。':undefined};
 const members=[OWNER,R1,R2].map((userId,i)=>({membershipId:`${GROUP}#${userId}`,groupId:GROUP,userId,ownerValue:userId,role:i===0?'OWNER':'MEMBER'}));
 const grants=c.existing.map(recipient=>({grantId:grantId(c,recipient),recordingSessionRecordId:id,ownerUserId:OWNER,groupId:GROUP,recipientUserId:recipient,recipientOwnerValue:recipient,isActive:true,grantedAt:now}));
 const session={id,recordingSessionId:c.session,userId:OWNER,sharedOwners:c.owners};
 const logs=Array.from({length:c.count},(_,i)=>({id:`log${i}`,recordingSessionId:c.session,userId:OWNER,sharedOwners:c.owners}));
 const group={groupId:GROUP,isActive:true,ownerUserId:OWNER};
 const api={get:async (table,key)=> {
 if(table.startsWith('RecordingSession-'))return session;
 if(table.startsWith('ShareGroup-'))return group;
 if(table.includes('ShareGroupMember-'))return members.find(x=>x.membershipId===key.membershipId);
 if(table.includes('HistoricalShareOperation'))return operation;
 return null;
 }, scan:async table => table.startsWith('LocationLog-')?logs:grants};
 return {c,session,operation,group,members,grants,logs,api};
}
(async()=>{
 for(const which of ['A','B']) {
 const f=fixture(which),s=await inspect(f.api,which),tx=transaction(s);
 assert.equal(s.logs.length,f.c.count); assert.equal(tx.length,7);
 assert.equal(tx[0].Put.Item.grantId,grantId(f.c,f.c.missing));
 assert.match(tx[0].Put.ConditionExpression,/attribute_not_exists/);
 assert.match(tx[1].Update.ConditionExpression,/#op = :op/);
 assert.equal(tx.filter(x=>x.ConditionCheck).length,5);
 if(which==='A')assert.ok(!tx[1].Update.UpdateExpression.includes('#status ='));
 if(which==='B')assert.ok(tx[1].Update.UpdateExpression.includes('recoveryOriginalRecipientUserId'));
 console.log('PASS',which,'dry-run inspection and conditional transaction');
 const bad=fixture(which);bad.logs[0].sharedOwners=[];
 await assert.rejects(()=>inspect(bad.api,which),/SAFETY BLOCK/);
 console.log('PASS',which,'log mismatch blocks recovery');
 const bad2=fixture(which);bad2.operation.operationId='unexpected';
 await assert.rejects(()=>inspect(bad2.api,which),/SAFETY BLOCK/);
 console.log('PASS',which,'operation mismatch blocks recovery');
 const bad3=fixture(which);bad3.group.isActive=false;
 await assert.rejects(()=>inspect(bad3.api,which),/SAFETY BLOCK/);
 console.log('PASS',which,'inactive group blocks recovery');
 }
 assert.deepEqual(owners([R2,R1]),[R2,R1].sort());
 console.log('9/9 recovery checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
