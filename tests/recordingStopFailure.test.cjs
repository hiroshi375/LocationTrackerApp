const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs');
function callback(name,env,source){
 const tree=ts.createSourceFile('hook.ts',source??fs.readFileSync('src/hooks/useForegroundLocationRecorder.ts','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);let target;
 function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)===name)target=n;ts.forEachChild(n,visit)}visit(tree);assert.ok(target);
 const text='const '+target.getText(tree)+';';const code=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return new Function(...Object.keys(env),code+';return '+name)(...Object.values(env));
}
function fixture(error,failJournal=false){
 const events=[],ref=v=>({current:v});
 const env={useCallback:f=>f,recordingSessionIdRef:ref('s'),recordingUserIdRef:ref('A'),recordingWatcherGenerationRef:ref(0),
 recordingSubscriptionRef:ref({remove(){events.push('watcher-removed')}}),liveLocationIdRef:ref('live'),isRecordingRef:ref(true),startLocationRef:ref({}),lastSavedLocationRef:ref({}),
 normalizedLiveShareOwnerValues:['viewer'],getActiveRecordingSettings:()=>({intervalMs:30000,distanceMeters:50}),
 recordingLifecycle:{async requestStop(){if(failJournal)throw Error('disk');events.push('intent-durable');return{state:'STOP_REQUESTED',stoppedAtMs:Date.now()}},stopped:async()=>events.push('stop-confirmed')},
 setContinuationPrompt:()=>{},drainSQLiteQueueBeforeStop:async()=>events.push('drain-kept'),
 stopBackgroundLocationRecording:async()=>{events.push('native-stop');if(error)throw error;},getBackgroundRecordingStatus:async()=>({state:null,hasStarted:false}),clearRecordingPlanLimitState:async()=>events.push('plan-cleared'),
 setActiveRecordingSessionId:()=>{},setRecordingStartedAt:()=>{},setDistanceFromStartMeters:()=>{},setIsRecording:v=>events.push('isRecording:'+v),saveLocationLog:async()=>{},updateLiveLocation:async()=>{},
 };
 return{env,events,stop:callback('stopRecording',env)};
}
test('failed native/cloud stop rejects before UI success or clearing the session',async()=>{
 const original=console.error;console.error=()=>{};try{
 const error=Error('network');const f=fixture(error);await assert.rejects(f.stop({skipFinalLocationSave:true}),e=>e===error);
 assert.equal(f.env.recordingSessionIdRef.current,'s');assert.equal(f.env.isRecordingRef.current,true);
 assert.deepEqual(f.events,['intent-durable','watcher-removed','native-stop']);
 }finally{console.error=original}
});
test('successful stop keeps existing owner/session and clears UI only after native confirmation',async()=>{
 const f=fixture();assert.equal(await f.stop({skipFinalLocationSave:true}),'s');assert.equal(f.env.recordingSessionIdRef.current,null);
 assert.ok(f.events.indexOf('native-stop')<f.events.indexOf('isRecording:false'));
});
test('durable intent write failure changes neither native watcher nor recording references',async()=>{
 const f=fixture(null,true);await assert.rejects(f.stop({skipFinalLocationSave:true}),/disk/);assert.deepEqual(f.events,[]);assert.equal(f.env.isRecordingRef.current,true);
});
test('restore never recreates foreground recording from a session with durable stop intent',async()=>{
 const ref=v=>({current:v}),events=[];
 const env={useCallback:f=>f,isRecording:false,isStartingRef:ref(false),intervalMs:30000,distanceMeters:50,resetRecordingState:()=>{},
 getBackgroundRecordingStatus:async()=>({hasStarted:true,state:{userId:'A',recordingSessionId:'s',isRecording:true}}),getCurrentUser:async()=>({userId:'A'}),
 recordingLifecycle:{read:async()=>({state:'STOP_REQUESTED'})},stopBackgroundLocationRecording:async()=>events.push('retry-stop'),
 recordingSessionIdRef:ref(null),recordingUserIdRef:ref(null),setIsRecording:()=>events.push('restore-recording')};
 await callback('restoreRecordingState',env)();assert.deepEqual(events,['retry-stop']);assert.equal(env.recordingSessionIdRef.current,null);
});

function nativeStopFixture(cloudError,legacyState=false){
 const events=[],state={userId:'A',recordingSessionId:'s',isRecording:true,intervalMs:30000,distanceMeters:50,liveShareOwnerValues:['viewer']};let nativeRunning=true,intent=null;
 if(legacyState){delete state.intervalMs;delete state.distanceMeters;}
 const source=fs.readFileSync('src/services/backgroundLocationService.ts','utf8');const tree=ts.createSourceFile('b.ts',source,ts.ScriptTarget.Latest,true);let node;
 function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.getText(tree)==='stopBackgroundLocationRecording')node=n;ts.forEachChild(n,visit)}visit(tree);assert.ok(node);
 const code=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const env={withBackgroundLifecycleLock:async(_key,work)=>work(),AsyncStorage:{getItem:async()=>JSON.stringify(state)},BACKGROUND_RECORDING_STATE_KEY:'state',BACKGROUND_LOCATION_TASK_NAME:'task',
 recordingLifecycle:{requestStop:async r=>{assert.equal(r.intervalMs,30000);assert.equal(r.distanceMeters,50);intent={state:'STOP_REQUESTED'};events.push('durable-stop')},read:async()=>intent,stopped:async()=>events.push('confirmed')},
 Location:{hasStartedLocationUpdatesAsync:async()=>nativeRunning,stopLocationUpdatesAsync:async()=>{nativeRunning=false;events.push('native-stopped')}},
 stopBackgroundLocationRecordingInternal:async()=>{assert.equal(nativeRunning,false);events.push('cloud-finalize');if(cloudError)throw cloudError;},
 resumeNativeRecordingInbox:async()=>events.push('BAD-reopen')};
 const exports={};new Function('exports',...Object.keys(env),code)(exports,...Object.values(env));return{events,run:()=>exports.stopBackgroundLocationRecording({expectedRecordingSessionId:'s',continueLiveSharing:true}),running:()=>nativeRunning};
}
test('network finalization failure cannot leave native GPS recording running or reopen the sealed journal',async()=>{
 const f=nativeStopFixture(Error('offline'));await assert.rejects(f.run(),/offline/);
 assert.equal(f.running(),false);assert.deepEqual(f.events,['durable-stop','native-stopped','cloud-finalize']);
});
test('native stop precedes cloud/sharing finalization and durable confirmation',async()=>{
 const f=nativeStopFixture();await f.run();assert.deepEqual(f.events,['durable-stop','native-stopped','cloud-finalize','confirmed']);
});

test('post-stop queue row is retained without skip/delete/failure marking or a cloud request',async()=>{
 const source=fs.readFileSync('src/services/locationQueueUploadService.ts','utf8'),tree=ts.createSourceFile('queue.ts',source,ts.ScriptTarget.Latest,true);let node;
 function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.getText(tree)==='drainLocationQueue')node=n;ts.forEachChild(n,visit)}visit(tree);assert.ok(node);
 const payload={user_id:'A',recording_session_id:'s',recorded_at_ms:1001,queue_status:'pending',latitude:35,longitude:139};const original=structuredClone(payload),events=[];
 const env={getRecordingPlanLimitState:async()=>null,matchingRecordingStart:()=>null,isBeforeRecordingStart:()=>false,SQLITE_QUEUE_UPLOAD_TIME_BUDGET_MS:10000,SQLITE_QUEUE_UPLOAD_MIN_AGE_MS:0,resolveQueueUploadMaxItems:()=>25,ENABLE_LOCATION_QUALITY_REVIEW:false,
 getPendingLocationQueueRows:async()=>[payload],recordingLifecycle:{read:async()=>({state:'STOPPED',stoppedAtMs:1000})},
 mayReplayStoppedPoint:(r,t)=>t<=r.stoppedAtMs,markLocationQueueRowSkipped:async()=>events.push('BAD-skip'),createLocationLog:async()=>events.push('BAD-send')};
 const code=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const fn=new Function(...Object.keys(env),code+';return drainLocationQueue;')(...Object.values(env));const r=await fn({userId:'A',recordingSessionId:'s'});
 assert.equal(r.stopReason,'stoppedSessionReviewPending');assert.deepEqual(events,[]);assert.deepEqual(payload,original);assert.equal(r.failedCount,0);
 const earlyEnv={...env,matchingRecordingStart:()=>new Date(2000).toISOString(),isBeforeRecordingStart:(t,s)=>t<Date.parse(s)};
 const early=new Function(...Object.keys(earlyEnv),code+';return drainLocationQueue;')(...Object.values(earlyEnv));
 const held=await early({userId:'A',recordingSessionId:'s'});
 assert.equal(held.stopReason,'startBoundaryReviewPending');assert.deepEqual(events,[]);assert.deepEqual(payload,original);assert.equal(held.processedCount,0);

});
test('discard UI protects an already stored summary before local discard fence or server mutation',async()=>{
 const events=[],env={pendingSessionId:'s',savingSessionName:false,sessionNameMutationRef:{current:false},Keyboard:{dismiss(){}},setSavingSessionName:()=>{},
 getCurrentUser:async()=>({userId:'A'}),ensureSessionStopped:async()=>({state:'STOPPED'}),hasSessionSummary:async()=>true,isLocationQueueSessionDiscarded:async()=>false,
 pendingRecordingIntervalMs:30000,recordIntervalMs:30000,pendingRecordingDistanceMeters:50,recordDistanceMeters:50,pendingSessionShareOwnerValues:[],
 recordingLifecycle:{confirmExistingSaved:async()=>events.push('protect-saved')},planStopReceipts:{acknowledge:async()=>events.push('ack')},
 setSessionNameModalVisible:v=>events.push('modal:'+v),setPendingSessionId:()=>{},Alert:{alert:()=>events.push('notice')},
 requestLocationQueueSessionDiscard:async()=>events.push('BAD-local-discard'),client:{mutations:{discardRecordingSession:async()=>events.push('BAD-server-discard')}}};
 await callback('handleDiscardSession',env,fs.readFileSync('src/screens/LocationHomeScreen.tsx','utf8'))();
 assert.deepEqual(events,['protect-saved','ack','modal:false','notice']);assert.equal(env.sessionNameMutationRef.current,false);
});
test('a stale plan-stop receipt cannot reopen the save dialog after confirmed save',async()=>{
 const events=[],env={useCallback:f=>f,AppState:{currentState:'active'},sessionNameMutationRef:{current:false},sessionNameModalVisible:false,
 getCurrentUser:async()=>({userId:'A'}),planStopReceipts:{read:async()=>({userId:'A',recordingSessionId:'s'}),acknowledge:async()=>events.push('ack')},
 recordingLifecycle:{read:async()=>({state:'SAVED'})},getBackgroundRecordingStatus:async()=>{throw Error('must not restore')},clearPlanLimitAutoStop:()=>{}};
 await callback('showPendingPlanStop',env,fs.readFileSync('src/screens/LocationHomeScreen.tsx','utf8'))();assert.deepEqual(events,['ack']);
});

test('legacy pending discard is detected before a new save intent can poison its retry state',async()=>{
 const events=[],env={pendingSessionId:'s',sessionNameMutationRef:{current:false},setSavingSessionName:()=>{},getCurrentUser:async()=>({userId:'A'}),
 ensureSessionStopped:async()=>{},pendingRecordingIntervalMs:30000,recordIntervalMs:30000,pendingRecordingDistanceMeters:50,recordDistanceMeters:50,pendingSessionShareOwnerValues:[],
 isLocationQueueSessionDiscarded:async()=>true,setDiscardRequested:()=>events.push('resume-discard'),Alert:{alert:()=>events.push('notice')},
 recordingLifecycle:{prepareSave:async()=>events.push('BAD-save-intent')}};
 await callback('saveSessionName',env,fs.readFileSync('src/screens/LocationHomeScreen.tsx','utf8'))('name');assert.deepEqual(events,['resume-discard','notice']);
});

test('legacy recording state without sampling fields can still persist a valid stop intent and stop',async()=>{
 const f=nativeStopFixture(null,true);await f.run();assert.equal(f.running(),false);assert.ok(f.events.includes('confirmed'));
});
test('start API rejects reusing a closed session but permits a genuinely new session after saving',async()=>{
 const source=fs.readFileSync('src/services/backgroundLocationService.ts','utf8'),tree=ts.createSourceFile('b.ts',source,ts.ScriptTarget.Latest,true);let node;
 function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.getText(tree)==='startBackgroundLocationRecording')node=n;ts.forEachChild(n,visit)}visit(tree);assert.ok(node);
 const code=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const started=[],env={withBackgroundLifecycleLock:async(_key,work)=>work(),recordingLifecycle:{read:async(_u,s)=>s==='old'?{state:'SAVED'}:null,pending:async()=>[]},startBackgroundLocationRecordingInternal:async p=>started.push(p.recordingSessionId)};
 const exports={};new Function('exports',...Object.keys(env),code)(exports,...Object.values(env));
 await assert.rejects(exports.startBackgroundLocationRecording({userId:'A',recordingSessionId:'old'}),/再開できません/);
 await exports.startBackgroundLocationRecording({userId:'A',recordingSessionId:'new'});assert.deepEqual(started,['new']);
});


test('actual background save rejects a pre-start batched fix before plan/lock/API; start boundary itself proceeds',async()=>{
 const source=fs.readFileSync('src/tasks/backgroundLocationTask.ts','utf8');
 const tree=ts.createSourceFile('background.ts',source,ts.ScriptTarget.Latest,true);let node;
 function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.getText(tree)==='saveBackgroundLocation')node=n;ts.forEachChild(n,visit)}visit(tree);assert.ok(node);
 const events=[],state={userId:'A',recordingSessionId:'new',startedAt:new Date(2000).toISOString()};
 const env={isBeforeRecordingStart:(t,s)=>t<Date.parse(s),observeLocationDecision:f=>events.push(f().reason),evaluateRecordingPlanDurationLimit:async()=>{throw Error('reached-normal-plan-path')}};
 const code=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const run=new Function(...Object.keys(env),code+';return saveBackgroundLocation;')(...Object.values(env));
 const point={timestamp:1999,coords:{latitude:35,longitude:139,accuracy:10}};
 const old=structuredClone(point);const result=await run(point,state,'receipt',{});
 assert.equal(result.skippedReason,'beforeRecordingStart');assert.deepEqual(point,old);assert.deepEqual(events,['beforeRecordingStart']);
 await assert.rejects(run({...point,timestamp:2000},state,'receipt',{}),/reached-normal-plan-path/);
});
