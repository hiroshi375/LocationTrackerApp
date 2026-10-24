const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('actual native registry survives interleaved dispatch/completion and duplicate completion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aclog-events-'));
  try {
    const harness = join(directory, 'EventRegistryTest.java');
    writeFileSync(harness, `package expo.modules.taskManager;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public class EventRegistryTest {
  public static void main(String[] args) throws Exception {
    TaskEventRegistry registry = new TaskEventRegistry();
    if (!registry.add("app", "old")) throw new AssertionError("first event");
    registry.add("other", "protected");
    if (!registry.finish("app", "old")) throw new AssertionError("last completion");
    registry.add("app", "new");
    if (registry.finish("app", "old")) throw new AssertionError("stale completion ended new event");
    if (!registry.hasEvents("app")) throw new AssertionError("new event lost");
    registry.finish("app", "new");
    ExecutorService pool = Executors.newFixedThreadPool(4);
    CountDownLatch start = new CountDownLatch(1);
    AtomicReference<Throwable> error = new AtomicReference<>();
    for (int t = 0; t < 4; t++) {
      final int worker = t;
      pool.submit(() -> {
        try {
          start.await();
          for (int i = 0; i < 25000; i++) {
            String id = worker + ":" + i;
            registry.add("app", id);
            if ((i & 7) == 0) Thread.yield();
            registry.finish("app", id);
          }
        } catch (Throwable failure) { error.compareAndSet(null, failure); }
      });
    }
    start.countDown(); pool.shutdown();
    if (!pool.awaitTermination(30, TimeUnit.SECONDS)) throw new AssertionError("deadlock");
    if (error.get() != null) throw new AssertionError(error.get());
    if (registry.hasEvents("app")) throw new AssertionError("leaked events");
    if (!registry.hasEvents("other")) throw new AssertionError("scope crossed");
    System.out.println("PASS");
  }
}`);
    execFileSync('javac', ['-d', directory, resolve('node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskEventRegistry.java'), harness]);
    assert.equal(execFileSync('java', ['-cp', directory, 'expo.modules.taskManager.EventRegistryTest'], { encoding: 'utf8', timeout: 40000 }).trim(), 'PASS');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
