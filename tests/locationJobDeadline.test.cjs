const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('repeated GPS merges keep the first job deadline; clock reset is safe', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aclog-deadline-'));
    try {
        const harness = join(directory, 'LocationDeadlineTest.java');
        writeFileSync(harness, `package expo.modules.taskManager;
public class LocationDeadlineTest {
  public static void main(String[] args) {
    long first = 100000L;
    // 5-second GPS arrivals for two minutes must not renew a one-minute deadline.
    for (long t = first; t <= first + 120000L; t += 5000L) {
      long remaining = LocationJobDeadline.remaining(t, first, 60000L);
      if (remaining != Math.max(0L, first + 60000L - t)) throw new AssertionError("deadline drift");
    }
    if (LocationJobDeadline.remaining(100L, 100000L, 60000L) != 60000L) throw new AssertionError("reboot");
    if (LocationJobDeadline.remaining(100L, -1L, 60000L) != 60000L) throw new AssertionError("legacy");
    if (LocationJobDeadline.age(100L, -1L) != -1L) throw new AssertionError("unknown age");
    System.out.println("PASS");
  }
}`);
        execFileSync('javac', ['-d', directory, resolve('node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/LocationJobDeadline.java'), harness]);
        assert.equal(execFileSync('java', ['-cp', directory, 'expo.modules.taskManager.LocationDeadlineTest'], { encoding: 'utf8' }).trim(), 'PASS');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
