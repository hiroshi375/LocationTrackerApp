import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React,{useEffect,useRef,useState} from 'react';
import { Alert,AppState,Button,ScrollView,Text } from 'react-native';
import * as Location from 'expo-location';
import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { capture,readRun,writeRun,exportProbeText,recordProbeOperation,PROBE_TASK } from './probeCapture';
import { makeProbeRun,probeOptions,PROBE_APPLICATION_ID,type ProbeRun,withProbeDeadline } from './probeCore';
export default function ProbeApp() {
 const [status,setStatus]=useState('状態確認中'),[busy,setBusy]=useState(false),[exporting,setExporting]=useState(false);
 const [run,setRun]=useState<ProbeRun|null>(null),[count,setCount]=useState(0),[operation,setOperation]=useState('なし');
 const subscription=useRef<Location.LocationSubscription|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),locked=useRef(false);
 const step=async<T,>(label:string,work:()=>Promise<T>):Promise<T>=>{
  setOperation(label);void recordProbeOperation(label,'begin').catch(()=>{});
  try {const result=await withProbeDeadline(work(),label);void recordProbeOperation(label,'complete').catch(()=>{});return result;}
  catch(e){void recordProbeOperation(label,'error').catch(()=>{});throw e;}
 };
 const refresh=async()=>{
  if(locked.current)return;
  const r=await withProbeDeadline(readRun(),'状態読取');setRun(r);
  setStatus(!r||r.stoppedAtMs?'停止中':Date.now()>=r.deadlineMs?'予定時間終了・停止確認が必要':`${r.mode==='foreground'?'前面':'背景'}比較中（${Math.round((r.deadlineMs-r.startedAtMs)/60000)}分）`);
 };
 const stop=async()=>{
  subscription.current?.remove();subscription.current=null;
  // Keep-awake cleanup must never block Native stop or log export.
  void deactivateKeepAwake('location-probe-foreground').catch(()=>{});if(timer.current)clearTimeout(timer.current);
  const active=await step('Native停止状態の確認',()=>Location.hasStartedLocationUpdatesAsync(PROBE_TASK));
  if(active)await step('Native測位を停止',()=>Location.stopLocationUpdatesAsync(PROBE_TASK));
  const current=await step('試験状態を読取',readRun);
  if(current&&!current.stoppedAtMs){const stopped={...current,stoppedAtMs:Date.now()};await step('停止状態を保存',()=>writeRun(stopped));setRun(stopped);}
  setStatus('停止中');
 };
 const perform=async(action:()=>Promise<void>)=>{
  if(locked.current)return;locked.current=true;setBusy(true);
  try{await action();}catch(e){setStatus('操作結果を確認してください');Alert.alert('測位比較エラー',e instanceof Error?e.message:String(e));}
  finally{locked.current=false;setBusy(false);setOperation('なし');}
 };
 useEffect(()=>{
  void refresh().catch(()=>setStatus('状態読取に失敗。ログ出力を試してください'));
  const listener=AppState.addEventListener('change',state=>{if(state==='active')void refresh().catch(()=>{});});
  const interval=setInterval(()=>{void refresh().catch(()=>{});},5000);
  return()=>{listener.remove();clearInterval(interval);subscription.current?.remove();if(timer.current)clearTimeout(timer.current);void deactivateKeepAwake('location-probe-foreground').catch(()=>{});};
 },[]);
 const start=async(mode:ProbeRun['mode'],minutes:10|110=10)=>{
  if(Application.applicationId!==PROBE_APPLICATION_ID)throw Error('PROBE_APP_ONLY');
  // Permission dialogs are user-controlled; do not impose a timeout while the user is reading them.
  setOperation('位置情報の許可を確認');
  const permission=await Location.requestForegroundPermissionsAsync();if(permission.status!=='granted')throw Error('位置情報の許可が必要です');
  if(permission.android?.accuracy!=='fine')throw Error('正確な位置情報を許可してください');
  if(mode==='background'&&(await Location.requestBackgroundPermissionsAsync()).status!=='granted')throw Error('背景比較には「常に許可」が必要です');
  await stop();const current=makeProbeRun(mode,Date.now(),minutes);await step('開始状態を保存',()=>writeRun(current));setRun(current);setCount(0);
  if(mode==='foreground'){
   await step('画面表示を維持',()=>activateKeepAwakeAsync('location-probe-foreground'));
   subscription.current=await step('前面測位を開始',()=>Location.watchPositionAsync({...probeOptions(),accuracy:Location.Accuracy.BestForNavigation},l=>{void capture(current,l,'foreground').then(()=>setCount(n=>n+1)).catch(()=>setStatus('測位の保存エラー'));}));
   timer.current=setTimeout(()=>{void perform(stop);},5*60_000);
  }else await step('背景測位を開始',()=>Location.startLocationUpdatesAsync(PROBE_TASK,{...probeOptions(),accuracy:Location.Accuracy.BestForNavigation,foregroundService:{notificationTitle:'AcLog 測位比較',notificationBody:'比較中。終了時は停止状態を確認してください。',killServiceOnDestroy:true}}));
  setStatus(mode==='foreground'?'前面比較中（5分）':`背景比較中（${minutes}分）`);
 };
 const exportLog=async()=>{
  if(exporting)return;setExporting(true);
  try{
   const text=await withProbeDeadline(exportProbeText(),'ログ作成',60000);
   const file=FileSystem.cacheDirectory+`LocationProbe_${Date.now()}.json`;
   await withProbeDeadline(FileSystem.writeAsStringAsync(file,text),'出力保存');
   if(!await withProbeDeadline(Sharing.isAvailableAsync(),'共有可否'))throw Error('共有できません');
   await Sharing.shareAsync(file,{mimeType:'application/json'});
  }catch(e){Alert.alert('ログ出力エラー',e instanceof Error?e.message:String(e));}finally{setExporting(false);}
 };
 const running=Boolean(run&&!run.stoppedAtMs);
 return <ScrollView contentContainerStyle={{padding:28,paddingTop:60,gap:18}}>
 <Text style={{fontSize:26,fontWeight:'bold'}}>AcLog 測位比較</Text><Text>比較版10502・通常版と検証104は変更しません。ログイン・共有・クラウド送信はありません。</Text>
 <Text>状態：{status}</Text><Text>操作：{operation}</Text>
 <Text>開始：{run?new Date(run.startedAtMs).toLocaleString('ja-JP'):'未開始'}</Text>
 <Text>終了予定：{run?new Date(run.deadlineMs).toLocaleString('ja-JP'):'未開始'}</Text><Text>前面受信回数：{count}</Text>
 <Button title="前面5分の比較を開始" disabled={busy||exporting||running} onPress={()=>void perform(()=>start('foreground'))}/>
 <Button title="背景10分の比較を開始" disabled={busy||exporting||running} onPress={()=>void perform(()=>start('background',10))}/>
 <Button title="背景110分の比較を開始" disabled={busy||exporting||running} onPress={()=>void perform(()=>start('background',110))}/>
 <Button title="比較を停止" disabled={busy} onPress={()=>void perform(stop)}/>
 <Button title="比較ログを出力" disabled={exporting} onPress={()=>void exportLog()}/>
 <Text>出力は開始・停止の操作待ちでも利用できます。タイムアウトはNativeの取消・停止成功を意味しません。終了予定時刻に停止状態を確認してください。試験中の出力は途中経過です。</Text>
 </ScrollView>;
}
