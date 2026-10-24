const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');const {execFileSync}=require('node:child_process');
test('raw accelerometer gravity removal is positive-only; warmup/gaps/noise/slow motion/future timestamps remain safe',()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'aclog-raw-motion-'));
 try{
  const harness=join(dir,'RawTest.java');fs.writeFileSync(harness,`package expo.modules.location.taskConsumers;
public class RawTest {
 static void check(boolean c,String name){if(!c)throw new AssertionError(name);}
 static double seconds(long ns){return ns/1e9;}
 public static void main(String[] args){
  RawMotionEvidence e=new RawMotionEvidence();check(e.snapshot(0,3).state.equals("unknown"),"absent");
  for(long step:new long[]{80_000_000L,50_000_000L,20_000_000L,5_000_000L}){
   e.clear();for(long t=0;t<=60_000_000_000L;t+=step)e.add(t,.01*Math.sin(seconds(t)),0,9.806);
   RawMotionEvidence.Result r=e.snapshot(59_900_000_000L,3);check(r.state.equals("no_motion_detected"),"static rate "+step);check(r.residual.rms<.02,"gravity not mistaken for dynamic acceleration");check(r.raw.rms>9.7,"raw gravity retained transparently");check(!r.state.equals("quiet"),"lack of movement is not proof of immobility");
   check(e.snapshot(90_000_000_000L,3).state.equals("unknown"),"stale");check(e.snapshot(59_900_000_000L,0).state.equals("unknown"),"unreliable");
  }
  e.clear();for(long t=0;t<10_000_000_000L;t+=50_000_000L)e.add(t,0,0,9.806);check(e.snapshot(9_950_000_000L,3).state.equals("unknown"),"warmup");
  // Low-frequency stepping-like signal: a simulated sensor waveform, not a claim that every walker is detected.
  e.clear();for(long t=0;t<=60_000_000_000L;t+=50_000_000L)e.add(t,.3*Math.sin(seconds(t)*2*Math.PI*.5),0,9.806);
  check(e.snapshot(60_000_000_000L,3).state.equals("motion_observed"),"slow stepping preserved");
  e.clear();for(long t=0;t<=60_000_000_000L;t+=50_000_000L)e.add(t,.5*Math.sin(seconds(t)*2),.5*Math.cos(seconds(t)*2),9.806);
  check(e.snapshot(60_000_000_000L,3).state.equals("motion_observed"),"turning waveform preserved");
  e.clear();for(long t=0;t<=60_000_000_000L;t+=50_000_000L){double angle=seconds(t)<40?0:.5;e.add(t,9.806*Math.sin(angle),0,9.806*Math.cos(angle));}
  check(e.snapshot(60_000_000_000L,3).state.equals("motion_observed"),"orientation transition vetoes removal");
  e.add(65_000_000_000L,0,0,9.806);check(e.snapshot(65_000_000_000L,3).state.equals("unknown"),"gap resets warmup");
  e.add(65_050_000_000L,Double.NaN,0,9.8);check(e.snapshot(65_050_000_000L,3).state.equals("unknown"),"invalid resets");
  e.clear();for(long t=0;t<=60_000_000_000L;t+=50_000_000L)e.add(t,0,0,0);check(e.snapshot(60_000_000_000L,3).state.equals("unknown"),"zero stuck sensor is not quiet");
  e.clear();check(e.snapshot(60_000_000_000L,3).state.equals("unknown"),"session reset");System.out.println("PASS");
 }
}`);
  const base='tests/diagnostics/native/';execFileSync('javac',['-d',dir,resolve(base+'MotionEvidenceWindow.java'),resolve(base+'RawMotionEvidence.java'),harness]);assert.equal(execFileSync('java',['-cp',dir,'expo.modules.location.taskConsumers.RawTest'],{encoding:'utf8'}).trim(),'PASS');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
