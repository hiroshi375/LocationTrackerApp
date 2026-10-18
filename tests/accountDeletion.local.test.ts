import assert from "node:assert/strict";
import { test } from "node:test";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { accessDb, tables, getRow } from "../amplify/functions/share-group-api/groupAccessStore";
import { advanceAccountDeletion } from "../amplify/functions/share-group-api/accountDeletion";
import { advanceGroupJobBatch } from "../amplify/functions/share-group-api/groupAccessOperation";
import { assertAccountNotDeleting } from "../amplify/functions/share-group-api/accountDeletionGuard";
import { createLegacyLocationLog, createLegacyRecordingSession } from "../amplify/functions/share-group-api/legacyRecordingWrite";
import { ingestLocationLog } from "../amplify/functions/share-group-api/locationLogIngest";
import { sessionLogKey } from "../amplify/functions/share-group-api/sessionLogIndex";
const raw=new DynamoDBClient({endpoint:"http://127.0.0.1:18000",region:"ap-northeast-1",credentials:{accessKeyId:"local",secretAccessKey:"local"}});
const db=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}});
accessDb.send=db.send.bind(db);
const put=async(table:string,item:object)=>db.send(new PutCommand({TableName:table,Item:item}));
const rows=async(table:string)=>{let result:any[]=[];let cursor:any;do{let p=await db.send(new ScanCommand({TableName:table,ExclusiveStartKey:cursor,ConsistentRead:true}));result.push(...p.Items??[]);cursor=p.LastEvaluatedKey;}while(cursor);return result;};
async function setup(){
 const prefix=`DeleteTest${Date.now()}`;
 const specs: [string,string,string?][]=[
  ["ACCOUNT_DELETION_TABLE_NAME","userId"],["GROUP_ACCESS_OPERATION_TABLE_NAME","groupId","entryKey"],
  ["SHARE_GROUP_TABLE_NAME","groupId"],["SHARE_GROUP_MEMBER_TABLE_NAME","membershipId"],
  ["HISTORICAL_SHARE_GRANT_TABLE_NAME","grantId"],["HISTORICAL_RECORDING_SESSION_TABLE_NAME","id"],
  ["HISTORICAL_LOCATION_LOG_TABLE_NAME","id"],["HISTORICAL_SHARE_OPERATION_TABLE_NAME","recordingSessionRecordId"],
  ["SESSION_LOG_INDEX_TABLE_NAME","sessionKey","logId"],
  ...["LiveLocation","UserActivityMonthlySummary","UserActivityWeeklySummary","BackgroundLocationDebugLog","UserDeviceSession"].map(name=>[`ACCOUNT_DELETE_${name.toUpperCase()}_TABLE_NAME`,name==="UserDeviceSession"?"userId":"id"] as [string,string])
 ];
 for(const [env,key,sort]of specs){const table=prefix+env;process.env[env]=table;await raw.send(new CreateTableCommand({TableName:table,BillingMode:"PAY_PER_REQUEST",KeySchema:[{AttributeName:key,KeyType:"HASH"},...(sort?[{AttributeName:sort,KeyType:"RANGE" as const}]:[])],AttributeDefinitions:[key,...sort?[sort]:[]].map(AttributeName=>({AttributeName,AttributeType:"S" as const}))}));}
 for(const [groupId,owner]of [["G","B"],["H","A"]]){
  await put(tables.groups(),{groupId,ownerUserId:owner,name:groupId,isActive:true});
  for(const u of ["A","B","C"])await put(tables.members(),{membershipId:`${groupId}#${u}`,groupId,userId:u,ownerValue:u,role:owner===u?"OWNER":"MEMBER"});
 }
 for(const [u,recipients] of [["A",["B","C"]],["B",["A"]],["C",["A"]]] as const){
  const id=`recording-session:${u}:s${u}`;
  await put(tables.sessions(),{id,userId:u,owner:u,recordingSessionId:`s${u}`,sharedOwners:recipients});
  await put(tables.operations(),{recordingSessionRecordId:id,operationId:`op${u}`,ownerUserId:u,status:"COMPLETED",grantManaged:true});
  for(let n=0;n<3;n++){const logId=`${u}${n}`;await put(tables.logs(),{id:logId,userId:u,owner:u,recordingSessionId:`s${u}`,sharedOwners:recipients});await put(process.env.SESSION_LOG_INDEX_TABLE_NAME!,{sessionKey:sessionLogKey(u,`s${u}`),logId});}
  for(const recipient of recipients){let groupId=u==="C"||u==="B"?"G":"H";const grantId=JSON.stringify([id,groupId,recipient]);await put(tables.grants(),{grantId,recordingSessionRecordId:id,ownerUserId:u,recipientUserId:recipient,recipientOwnerValue:recipient,groupId,isActive:true,grantedAt:new Date().toISOString()});}
 }
 for(const env of specs.map(s=>s[0]).filter(e=>e.startsWith('ACCOUNT_DELETE_'))){for(const userId of ["A","B"])await put(process.env[env]!,{id:userId,userId,sharedOwners:[]});}
 // Force more than one scan page, with unrelated data that must survive.
 for(let n=0;n<205;n++)await put(tables.logs(),{id:`keep${n}`,userId:"Z",recordingSessionId:"z",sharedOwners:[]});
 await put(process.env.ACCOUNT_DELETION_TABLE_NAME!,{userId:"B",phase:0,status:"RUNNING",createdAt:"2020-01-01T00:00:00Z"});
}
test('account deletion resumes after checkpoint failure and preserves other owners / old-new recording',async()=>{
 await setup();
 await assert.rejects(advanceAccountDeletion(''),/UNAUTHORIZED/);
 await db.send(new UpdateCommand({TableName:process.env.ACCOUNT_DELETION_TABLE_NAME!,Key:{userId:'B'},UpdateExpression:'SET leaseToken=:t, leaseUntil=:u',ExpressionAttributeValues:{':t':'other-request',':u':Date.now()+45000}}));
 assert.equal((await advanceAccountDeletion('B')).completed,false);
 assert.equal((await rows(tables.grants())).length,4);
 await db.send(new UpdateCommand({TableName:process.env.ACCOUNT_DELETION_TABLE_NAME!,Key:{userId:'B'},UpdateExpression:'REMOVE leaseToken, leaseUntil'}));
 const send=db.send.bind(db);let injected=false;
 accessDb.send=(async(command:any)=>{
  if(!injected&&command.constructor.name==='UpdateCommand'&&command.input.UpdateExpression.includes('#p=:phase')){injected=true;throw new Error('injected checkpoint failure');}
  return send(command);
 }) as any;
 let sawFailure=false;
 for(let i=0;i<100&&!sawFailure;i++){
  for(const row of await rows(tables.jobs()))if(row.recordType==='JOB'&&row.status==='READY')await advanceGroupJobBatch(row.groupId,row.operationId);
  for(const row of await rows(tables.jobs()))if(row.recordType==='JOB'&&row.status==='FAILED')throw new Error(JSON.stringify(row));
  try{await advanceAccountDeletion('B');}catch(error){assert.match(String(error),/checkpoint/);sawFailure=true;}
 }
 assert.equal(sawFailure,true);
 accessDb.send=send;
 let completed=false;
 for(let i=0;i<300;i++){
  for(const row of await rows(tables.jobs()))if(row.recordType==='JOB'&&row.status==='READY')await advanceGroupJobBatch(row.groupId,row.operationId);
  const result=await advanceAccountDeletion('B');if(result.completed){completed=true;break;}
 }
 assert.equal(completed,true);
 assert.equal((await rows(tables.logs())).some(r=>r.userId==='B'),false);
 assert.equal((await rows(tables.sessions())).some(r=>r.userId==='B'),false);
 assert.equal((await rows(tables.logs())).filter(r=>r.userId==='Z').length,205);
 const a=await getRow(tables.sessions(),{id:'recording-session:A:sA'});assert.deepEqual(a?.sharedOwners,['C']);
 const c=await getRow(tables.sessions(),{id:'recording-session:C:sC'});assert.deepEqual(c?.sharedOwners,[]);
 assert.equal((await rows(tables.grants())).some(r=>r.ownerUserId==='B'||r.recipientUserId==='B'),false);
 assert.equal((await rows(tables.members())).some(r=>r.userId==='B'),false);
 assert.equal(JSON.stringify(await rows(tables.jobs()),(_k,v)=>v instanceof Set?[...v]:v).includes('B'),false);
 assert.equal((await getRow(tables.operations(),{recordingSessionRecordId:'recording-session:A:sA'}))?.grantManaged,true);
 assert.equal((await rows(process.env.SESSION_LOG_INDEX_TABLE_NAME!)).some(r=>r.sessionKey===sessionLogKey('B','sB')),false);
 for(const name of ['LiveLocation','UserActivityMonthlySummary','UserActivityWeeklySummary','BackgroundLocationDebugLog','UserDeviceSession']){
  const items=await rows(process.env[`ACCOUNT_DELETE_${name.toUpperCase()}_TABLE_NAME`]!);assert.equal(items.some(r=>r.userId==='B'),false);assert.equal(items.some(r=>r.userId==='A'),true);
 }
 await assert.rejects(assertAccountNotDeleting('B'),/ACCOUNT_DELETING/);await assertAccountNotDeleting('A');
 assert.equal((await advanceAccountDeletion('B')).completed,true);
 assert.equal(typeof (await getRow(process.env.ACCOUNT_DELETION_TABLE_NAME!,{userId:'B'}))?.expiresAt,'number');
 const input={userId:'A',recordingSessionId:'fresh',startedAt:'2026-10-19T00:00:00Z',endedAt:'2026-10-19T00:01:00Z',distanceMeters:1,pointCount:0};
 await createLegacyRecordingSession('A','a',{...input,id:'recording-session:A:fresh'});
 const log={id:'old-api',userId:'A',recordingSessionId:'fresh',recordedAt:'2026-10-19T00:00:00Z',latitude:35,longitude:139};
 assert.equal((await createLegacyLocationLog('A','a',log))?.id,'old-api');
 assert.equal((await ingestLocationLog('A','a',{...log,id:'new-api',recordedAt:'2026-10-19T00:00:10Z'})).created,true);
});
