const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('actual TaskService cleanup keeps a manager until its ReactContext is destroyed', () => {
  const source = fs.readFileSync(resolve('node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java'), 'utf8');
  const start = source.indexOf('  private void invalidateAppRecord(String appScopeKey) {');
  assert.ok(start >= 0);
  let depth = 0, end;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // Extract only this real method; no Android runtime is required for cleanup policy.
  const method = source.slice(start, end);
  const directory = fs.mkdtempSync(join(tmpdir(), 'aclog-cleanup-'));
  try {
    const harness = join(directory, 'CleanupTest.java');
    fs.writeFileSync(harness, `import java.util.*;
public class CleanupTest {
  static class TaskInterface { Map<String,Object> options = new HashMap<>(); Map<String,Object> getOptions(){return options;} }
  static class HeadlessAppLoader { int calls; boolean invalidateApp(String scope){ calls++; return true; } }
  static class LocationJobDeadline { static final String TASK_NAME="location"; }
  final Map<String,Object> sHeadlessTaskManagers = new HashMap<>();
  final HeadlessAppLoader loader = new HeadlessAppLoader();
  TaskInterface task;
  TaskInterface getTask(String name,String scope){return task;}
  HeadlessAppLoader getAppLoader(){return loader;}
  void writeHeadlessDiagnostic(String event,String details){}
${method}
  public static void main(String[] args){
    CleanupTest test = new CleanupTest(); Object liveManager = new Object();
    test.sHeadlessTaskManagers.put("app",liveManager);
    test.invalidateAppRecord("app");
    if(test.loader.calls!=1) throw new AssertionError("idle cleanup skipped");
    if(test.sHeadlessTaskManagers.get("app")!=liveManager) throw new AssertionError("foreground context lost its manager");
    test.task=new TaskInterface(); test.task.options.put("foregroundService",new Object());
    test.invalidateAppRecord("app");
    if(test.loader.calls!=1) throw new AssertionError("continuous location runtime destroyed");
    test.task=null; test.invalidateAppRecord("app");
    if(test.loader.calls!=2) throw new AssertionError("cleanup after stop broken");
    System.out.println("PASS");
  }
}`);
    execFileSync('javac', ['-d', directory, harness]);
    assert.equal(execFileSync('java', ['-cp', directory, 'CleanupTest'], { encoding: 'utf8' }).trim(), 'PASS');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
