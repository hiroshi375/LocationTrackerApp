import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { accessDb, getRow, tables, type Row } from "./groupAccessStore";
import { requestGroupAccessChange, getGroupJob, resumeGroupJob } from "./groupAccessOperation";
import { accountRelated, isAccountOwnerValue, ownsIndex, withoutAccount } from "./accountDeletionPolicy";

const jobTable = () => {
    const table = process.env.ACCOUNT_DELETION_TABLE_NAME;
    if (!table) throw new Error("アカウント削除APIは未設定です。");
    return table;
};
const modelTable = (name: string) => {
    const value = process.env[`ACCOUNT_DELETE_${name.toUpperCase()}_TABLE_NAME`];
    if (!value) throw new Error(`削除対象テーブルが未設定です: ${name}`);
    return value;
};
type Phase = {name:string; table:()=>string; keys:string[]; kind:"groups"|"members"|"jobs"|"operations"|"grant"|"projection"|"index"|"owned"|"ownedGroups"};
// Groups/members remain until all affected sharing projections have been repaired.
// Profiles are deliberately left for the client to remove AFTER S3 deletion.
const phases:Phase[] = [
    {name:"共有の失効",table:tables.groups,keys:["groupId"],kind:"groups"},
    {name:"所属の解除",table:tables.members,keys:["membershipId"],kind:"members"},
    {name:"Grant",table:tables.grants,keys:["grantId"],kind:"grant"},
    {name:"共有操作履歴",table:tables.operations,keys:["recordingSessionRecordId"],kind:"operations"},
    {name:"グループ操作履歴",table:tables.jobs,keys:["groupId","entryKey"],kind:"jobs"},
    ...[tables.sessions,tables.logs,()=>modelTable("LiveLocation")].map((table,i):Phase=>({name:["履歴","位置記録","現在地"][i],table,keys:["id"],kind:"projection"})),
    {name:"ログ索引",table:()=>process.env.SESSION_LOG_INDEX_TABLE_NAME!,keys:["sessionKey","logId"],kind:"index"},
    ...["UserActivityMonthlySummary","UserActivityWeeklySummary","BackgroundLocationDebugLog","UserDeviceSession"].map((name):Phase=>({name,table:()=>modelTable(name),keys:[name==="UserDeviceSession"?"userId":"id"],kind:"owned"})),
    {name:"所有グループ",table:tables.groups,keys:["groupId"],kind:"ownedGroups"},
];
function terminal(row:Row) { return ["COMPLETED","CANCELLED"].includes(row.status); }
async function relatedGroup(row:Row,userId:string) {
    if (!row.groupId) return false;
    const group=await getRow(tables.groups(),{groupId:row.groupId});
    return group?.ownerUserId===userId;
}
async function settleGroup(userId:string,groupId:string,action:"DELETE"|"LEAVE") {
    const group=await getRow(tables.groups(),{groupId});
    if(!group) return true;
    const state=await getRow(tables.jobs(),{groupId,entryKey:"GATE"});
    if(state?.lockToken) return false;
    if(state?.activeJobId) {
        const job=await getGroupJob(groupId,state.activeJobId,userId);
        if(job.status==="FAILED") await resumeGroupJob(groupId,job.operationId,userId);
        return false;
    }
    if(group.isActive!==true) return true;
    await requestGroupAccessChange(userId,groupId,action,undefined,`account-delete-${action}`);
    return false;
}

/** One bounded, restartable scan page. Identity is supplied ONLY by the authenticated resolver. */
export async function advanceAccountDeletion(userId:string) {
    if(!userId?.trim()) throw new Error("UNAUTHORIZED");
    const table=jobTable();
    let job=await getRow(table,{userId});
    if(!job){
        try { await accessDb.send(new PutCommand({TableName:table,Item:{userId,phase:0,status:"RUNNING",createdAt:new Date().toISOString()},ConditionExpression:"attribute_not_exists(userId)"})); }
        catch(error) { if((error as Error).name!=="ConditionalCheckFailedException") throw error; }
        job=await getRow(table,{userId});
    }
    // Let already-admitted 30s Lambda invocations finish before deleting any rows.
    if(job && Date.now()-Date.parse(job.createdAt)<35000) return {completed:false,phase:"実行中の記録処理の終了待ち"};
    if(job?.status==="COMPLETED") return {completed:true,phase:"サーバーデータ削除済み"};
    const token=randomUUID(),now=Date.now();
    try {await accessDb.send(new UpdateCommand({TableName:table,Key:{userId},UpdateExpression:"SET leaseToken=:token, leaseUntil=:until",ConditionExpression:"attribute_not_exists(leaseUntil) OR leaseUntil < :now",ExpressionAttributeValues:{":token":token,":until":now+45000,":now":now}}));}
    catch(error){if((error as Error).name==="ConditionalCheckFailedException") return {completed:false,phase:"処理中"};throw error;}
    const fence={ConditionCheck:{TableName:table,Key:{userId},ConditionExpression:"leaseToken=:token AND leaseUntil >= :now",ExpressionAttributeValues:{":token":token,":now":Date.now()}}};
    const phase=phases[job!.phase];
    let checkpointed=false;
    try {
        if(!phase)throw new Error("削除工程が不正です。");
        const tableName=phase.table();
        if(!tableName)throw new Error(`削除対象テーブルが未設定です: ${phase.name}`);
        const page=await accessDb.send(new ScanCommand({TableName:tableName,ConsistentRead:true,Limit:["groups","members","jobs"].includes(phase.kind)?20:200,ExclusiveStartKey:job!.cursor ?? undefined}));
        let nextCursor=page.LastEvaluatedKey;
        const deadline=Date.now()+10000;
        for(const row of page.Items??[]){
            const key=Object.fromEntries(phase.keys.map(k=>[k,row[k]]));
            let remove=false;let updated:Row|undefined;
            if(phase.kind==="groups" && row.ownerUserId===userId){
                if(!await settleGroup(userId,row.groupId,"DELETE"))return {completed:false,phase:phase.name};
            } else if(phase.kind==="members" && row.userId===userId){
                if(!await settleGroup(userId,row.groupId,"LEAVE"))return {completed:false,phase:phase.name};
                remove=true;
            } else if(phase.kind==="grant") {
                const ownGroup=await relatedGroup(row,userId);
                if(ownGroup&&row.isActive===true&&row.ownerUserId!==userId&&row.recipientUserId!==userId)
                    throw new Error("NEEDS_REPAIR: 無効な所有グループに有効Grantが残っています。権限投影を確認してください。");
                remove=accountRelated(row,userId)||ownGroup;
            }
            else if(phase.kind==="projection") {
                remove=row.userId===userId;
                if(!remove && Array.isArray(row.sharedOwners) && row.sharedOwners.some((o:unknown)=>isAccountOwnerValue(o,userId)))
                    updated={...row,sharedOwners:withoutAccount(row.sharedOwners,userId)};
            } else if(phase.kind==="operations") {
                if(accountRelated(row,userId)||await relatedGroup(row,userId)) {
                    if(!terminal(row)) throw new Error("未完了の履歴共有処理を復旧してから削除を再開してください。");
                    remove=row.ownerUserId===userId;
                    if(!remove){
                        updated={...row};
                        for(const field of ["recipientUserId","recipientOwnerValue","grantId","groupId","requestedEnabled"])delete updated[field];
                    }
                }
            } else if(phase.kind==="jobs") {
                const owned=await relatedGroup(row,userId);
                const session=row.sessionId?await getRow(tables.sessions(),{id:row.sessionId}):undefined;
                const ownWork=session?.userId===userId;
                const grantIds:unknown[]=row.grantIds instanceof Set?[...row.grantIds]:(Array.isArray(row.grantIds)?row.grantIds:[]);
                const remainingIds=grantIds.filter(id=>!String(id).includes(userId));
                const workReference=remainingIds.length!==grantIds.length;
                const involved=workReference||ownWork||owned||row.requesterUserId===userId||row.targetUserId===userId||row.groupOwnerUserId===userId||row.memberUserIds?.includes(userId)||row.entryKey?.startsWith(`REQUEST#${userId}#`);
                if(involved){
                    if(row.recordType==="JOB"&&!terminal(row))throw new Error("未完了のグループ操作があります。完了後に削除を再開してください。");
                    if((ownWork||workReference)&&!terminal(row))throw new Error("未完了の履歴作業があります。");
                    remove=ownWork||owned||row.requesterUserId===userId||row.targetUserId===userId||row.entryKey?.startsWith(`REQUEST#${userId}#`);
                    if(!remove && workReference){
                        if(!remainingIds.length)remove=true;
                        else updated={...row,grantIds:row.grantIds instanceof Set?new Set(remainingIds):remainingIds};
                    }
                    if(!remove && row.memberUserIds) {
                        updated={...(updated??row),memberUserIds:row.memberUserIds.filter((v:string)=>v!==userId),memberOwnerValues:withoutAccount(row.memberOwnerValues,userId)};
                        if(updated.currentSession?.userId===userId){delete updated.currentSession;delete updated.currentWorkKey;}
                        if(Array.isArray(updated.targetGrantIds))updated.targetGrantIds=updated.targetGrantIds.filter((id:unknown)=>!String(id).includes(userId));
                        if(String(updated.errorMessage??"").includes(userId))delete updated.errorMessage;
                    }
                }
            } else if(phase.kind==="index") remove=ownsIndex(row,userId);
            else if(phase.kind==="owned") remove=row.userId===userId;
            else if(phase.kind==="ownedGroups") remove=row.ownerUserId===userId;
            if(remove||updated){
                // Compare the scanned item to its current value to fail safely on concurrent modification.
                const names:Record<string,string>={},values:Row={};
                const conditions=Object.keys(row).map((k,i)=>{names[`#f${i}`]=k;values[`:v${i}`]=row[k];return `#f${i}=:v${i}`;}).join(" AND ");
                const guard={ConditionExpression:conditions,ExpressionAttributeNames:names,ExpressionAttributeValues:values};
                const changes:Row={};
                if(updated){
                    const sets:string[]=[],removes:string[]=[];
                    let i=0;
                    for(const field of new Set([...Object.keys(row),...Object.keys(updated)])){
                        if(phase.keys.includes(field)||JSON.stringify(row[field])===JSON.stringify(updated[field]))continue;
                        const n=`#change${i}`,v=`:change${i++}`;names[n]=field;
                        if(updated[field]===undefined)removes.push(n);
                        else{values[v]=updated[field];sets.push(`${n}=${v}`);}
                    }
                    changes.Update={TableName:tableName,Key:key,...guard,UpdateExpression:[sets.length?`SET ${sets.join(", ")}`:"",removes.length?`REMOVE ${removes.join(", ")}`:""].filter(Boolean).join(" ")};
                }
                await accessDb.send(new TransactWriteCommand({TransactItems:[fence,remove?{Delete:{TableName:tableName,Key:key,...guard}}:changes]}));
            }
            if(Date.now()>=deadline){nextCursor=key;break;}
        }
        const next=nextCursor?job!.phase:job!.phase+1;
        const completed=next>=phases.length;
        await accessDb.send(new UpdateCommand({TableName:table,Key:{userId},UpdateExpression:"SET #p=:phase, #s=:status, #c=:cursor"+(completed?", expiresAt=:expiry":"")+" REMOVE leaseToken, leaseUntil",ConditionExpression:"leaseToken=:token",ExpressionAttributeNames:{"#p":"phase","#s":"status","#c":"cursor"},ExpressionAttributeValues:{":phase":next,":status":completed?"COMPLETED":"RUNNING",":cursor":nextCursor??null,":token":token,...(completed?{":expiry":Math.floor(Date.now()/1000)+7*86400}:{})}}));
        checkpointed=true;
        return {completed,phase:phase.name};
    } finally {
        if (!checkpointed) {
        try{await accessDb.send(new UpdateCommand({TableName:table,Key:{userId},UpdateExpression:"REMOVE leaseToken, leaseUntil",ConditionExpression:"leaseToken=:token",ExpressionAttributeValues:{":token":token}}));}
        catch(error){if((error as Error).name!=="ConditionalCheckFailedException") throw error;}
        }
    }
}
