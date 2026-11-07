import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as FileSystem from 'expo-file-system/legacy';
import * as Application from 'expo-application';
import { PROBE_APPLICATION_ID, type ProbeRun, inProbeWindow, withProbeDeadline } from './probeCore';
import { nativeLocationEvidence, sanitizeNativeLocationEvidence } from '../../src/services/locationDecisionDiagnosticCore';
export const PROBE_TASK = 'aclog-minimal-location-probe-v1';
const root = () => {
    if (Application.applicationId !== PROBE_APPLICATION_ID || !FileSystem.documentDirectory) throw Error('PROBE_APP_ONLY');
    return `${FileSystem.documentDirectory}minimal-location-probe/`;
};
export async function readRun(): Promise<ProbeRun | null> {
    const p=`${root()}current.json`; if (!(await FileSystem.getInfoAsync(p)).exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(p));
}
export async function writeRun(run: ProbeRun) {
    await FileSystem.makeDirectoryAsync(root(), { intermediates:true });
    await FileSystem.makeDirectoryAsync(`${root()}${run.id}/`, { intermediates:true });
    await FileSystem.writeAsStringAsync(`${root()}current.json`, JSON.stringify(run));
    await FileSystem.writeAsStringAsync(`${root()}${run.id}/run.json`, JSON.stringify({ ...run, requested: { accuracy:'BestForNavigation',intervalMs:5000,distanceMeters:0,mode:run.mode } }));
}
async function writeCapture(run: ProbeRun, location: Location.LocationObject, path: string) {
    if (!inProbeWindow(run,location.timestamp)) return;
    const evidence=sanitizeNativeLocationEvidence(nativeLocationEvidence(location));
    const row={schema:1,runId:run.id,path,receivedAtMs:Date.now(),timestamp:location.timestamp,
        coords:location.coords,native:evidence};
    // Immutable per-delivery files avoid read/modify/write races between foreground and headless JS.
    await FileSystem.writeAsStringAsync(`${root()}${run.id}/fix-${location.timestamp}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(row));
}
const pending = new Set<Promise<void>>();
let writeFailures = 0;
export function capture(run: ProbeRun, location: Location.LocationObject, path: string): Promise<void> {
    const operation = writeCapture(run, location, path); pending.add(operation);
    void operation.then(()=>pending.delete(operation),()=>{pending.delete(operation);writeFailures++;});
    return operation;
}
export async function exportProbeText() {
    await Promise.allSettled([...pending]);
    const run=await readRun(); if (!run) throw Error('NO_PROBE_RUN');
    const directory=`${root()}${run.id}/`,names=(await FileSystem.readDirectoryAsync(directory)).filter(n=>n.startsWith('fix-')&&n.endsWith('.json'));
    const errorNames=(await FileSystem.readDirectoryAsync(directory)).filter(n=>n.startsWith('task-error-')&&n.endsWith('.json'));
    const operationNames=(await FileSystem.readDirectoryAsync(directory)).filter(n=>n.startsWith('operation-')&&n.endsWith('.json'));
    const operations=[];for(const name of operationNames)operations.push(JSON.parse(await FileSystem.readAsStringAsync(directory+name)));
    const errors=[];for(const name of errorNames)errors.push(JSON.parse(await FileSystem.readAsStringAsync(directory+name)));
    const rows=[]; for(const name of names) rows.push(JSON.parse(await FileSystem.readAsStringAsync(directory+name)));
    rows.sort((a,b)=>a.timestamp-b.timestamp);
    return JSON.stringify({schema:1,run,requested:{accuracy:'BestForNavigation',intervalMs:5000,distanceMeters:0},writeFailuresInCurrentRuntime:writeFailures,errors,operations,rows},null,2);
}
export async function recordProbeOperation(label: string, phase: 'begin' | 'complete' | 'error') {
    const run=await readRun();if(!run)return;
    await FileSystem.writeAsStringAsync(`${root()}${run.id}/operation-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,JSON.stringify({label,phase,atMs:Date.now()}));
}
TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(PROBE_TASK,async ({data,error})=>{
    const run=await readRun(); if (!run||run.mode!=='background'||run.stoppedAtMs) return;
    if (error) {
        await FileSystem.writeAsStringAsync(`${root()}${run.id}/task-error-${Date.now()}.json`,JSON.stringify({code:error.code,atMs:Date.now()}));
        return;
    }
    for(const location of data?.locations??[]) await capture(run,location,'background');
    if(Date.now()>=run.deadlineMs) {
        try {
            if(await withProbeDeadline(Location.hasStartedLocationUpdatesAsync(PROBE_TASK),'auto-stop-check'))
                await withProbeDeadline(Location.stopLocationUpdatesAsync(PROBE_TASK),'auto-stop-native');
            await writeRun({...run,stoppedAtMs:Date.now()});
        } catch {
            await FileSystem.writeAsStringAsync(`${root()}${run.id}/task-error-${Date.now()}.json`,JSON.stringify({code:'AUTO_STOP_UNCONFIRMED',atMs:Date.now()}));
        }
    }
});
