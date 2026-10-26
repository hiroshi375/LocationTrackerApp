const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('old ReactContext teardown preserves a replacement foreground/headless manager', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aclog-registration-'));
  try {
    const harness = join(directory, 'RegistrationTest.java');
    writeFileSync(harness, `package expo.modules.taskManager;
import java.lang.ref.WeakReference;
import java.util.*;
public class RegistrationTest {
  public static void main(String[] args) {
    Object old = new Object(), replacement = new Object(), other = new Object();
    Map<String, WeakReference<Object>> foreground = new HashMap<>(), headless = new HashMap<>();
    foreground.put("app", new WeakReference<>(replacement));
    headless.put("app", new WeakReference<>(old));
    foreground.put("other-app", new WeakReference<>(other));
    if (TaskManagerRegistration.removeIfSame(foreground, "app", old)) throw new AssertionError("new manager removed");
    if (!TaskManagerRegistration.removeIfSame(headless, "app", old)) throw new AssertionError("old manager retained");
    if (foreground.get("app").get() != replacement) throw new AssertionError("replacement lost");
    if (foreground.get("other-app").get() != other) throw new AssertionError("scope crossed");
    if (TaskManagerRegistration.removeIfSame(headless, "app", old)) throw new AssertionError("duplicate teardown");
    if (!TaskManagerRegistration.removeIfSame(foreground, "app", replacement)) throw new AssertionError("normal teardown broken");
    System.out.println("PASS");
  }
}`);
    execFileSync('javac', ['-d', directory, resolve('node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerRegistration.java'), harness]);
    assert.equal(execFileSync('java', ['-cp', directory, 'expo.modules.taskManager.RegistrationTest'], { encoding: 'utf8' }).trim(), 'PASS');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
