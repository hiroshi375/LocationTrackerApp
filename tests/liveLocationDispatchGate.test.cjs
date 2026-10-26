const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('native live lane bounds flights and stale completion cannot release a replacement', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'aclog-live-gate-'));
  try {
    const harness = join(directory, 'GateTest.java');
    fs.writeFileSync(harness, `package expo.modules.location.taskConsumers;
public class GateTest {
 public static void main(String[] args) {
  LiveLocationDispatchGate gate = new LiveLocationDispatchGate();
  long a=gate.acquire(0); if(a==0)throw new AssertionError("initial");
  if(gate.acquire(30000)!=0)throw new AssertionError("overlap");
  long b=gate.acquire(45000); if(b==0 || b==a)throw new AssertionError("recover hung JS");
  gate.finish(a); if(gate.acquire(60000)!=0)throw new AssertionError("old finish released replacement");
  gate.finish(b); long c=gate.acquire(60000); if(c==0)throw new AssertionError("finished");
  gate.finish(c); if(gate.acquire(60001)!=0)throw new AssertionError("rate");
  System.out.println("PASS");
 }
}`);
    execFileSync('javac', ['-d', directory, resolve('node_modules/expo-location/android/src/main/java/expo/modules/location/taskConsumers/LiveLocationDispatchGate.java'), harness]);
    assert.equal(execFileSync('java', ['-cp', directory, 'expo.modules.location.taskConsumers.GateTest'], { encoding: 'utf8' }).trim(), 'PASS');
  } finally { fs.rmSync(directory, {recursive:true, force:true}); }
});
