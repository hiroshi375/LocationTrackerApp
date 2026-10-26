const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const base='node_modules/expo-location/android/src/main/java/expo/modules/location/';
test('production location pipeline has no experimental sensor registration or quality response fields',()=>{
 for(const file of ['LocationModule.kt','taskConsumers/LocationTaskConsumer.kt','records/LocationResults.kt']){
  const s=fs.readFileSync(base+file,'utf8');assert.ok(!/MotionEvidenceCollector|aclogQualityEvidence|appendAcLogForegroundQualityAsync|getAcLogMotionSensorInventoryAsync|readAcLogMotionEvidenceAsync/.test(s),file);
 }
 for(const file of ['MotionEvidenceCollector.kt','MotionEvidenceWindow.java','RawMotionEvidence.java'])assert.equal(fs.existsSync(base+'taskConsumers/'+file),false);
});
test('removal leaves receipt handoff and owner deletion available to both old and new clients',()=>{
 const module=fs.readFileSync(base+'LocationModule.kt','utf8');for(const api of ['readAcLogRecordingInboxAsync','ackAcLogRecordingInboxAsync','sealAcLogRecordingInboxAsync','deleteAcLogRecordingInboxOwnerAsync','discardAcLogMotionEvidenceAsync'])assert.ok(module.includes('"'+api+'"'),api);
 const inbox=fs.readFileSync(base+'taskConsumers/RecordingInbox.kt','utf8');assert.ok(inbox.includes('INSERT OR IGNORE INTO points('));assert.ok(inbox.includes('db.delete("points", "owner=? AND session=? AND id=?"'));
});
test('support log export no longer reads or exports raw location/sensor diagnostics',()=>{
 const exporter=fs.readFileSync('src/services/headlessDiagnosticExportService.ts','utf8');assert.ok(!/getOwnQueueMotionEvidence|readOwnNativeQualityEvidence|readOwnMotionSensorInventory|OWN NATIVE QUALITY EVIDENCE|OWN QUEUE MOTION EVIDENCE/.test(exporter));assert.ok(exporter.includes('JS TASK STAGES'));assert.ok(exporter.includes('PREVIOUS'));
 const queue=fs.readFileSync('src/services/locationLocationQueueService.ts','utf8');assert.ok(!queue.includes('getOwnQueueMotionEvidence'));assert.ok(queue.includes('discarded_recording_sessions'));assert.ok(queue.includes('acceptedLocationBaselines.discard'));
});
