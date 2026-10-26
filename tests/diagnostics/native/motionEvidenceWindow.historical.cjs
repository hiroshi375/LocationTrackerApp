const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');const {execFileSync}=require('node:child_process');
test('native sensor window: quiet/movement, cold start, gaps, stale evidence, bound and reset',()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'aclog-motion-'));
 try{
  const harness=join(dir,'MotionTest.java');fs.writeFileSync(harness,`package expo.modules.location.taskConsumers;
public class MotionTest {
 static void check(boolean condition,String name){if(!condition)throw new AssertionError(name);}
 public static void main(String[] args){
  MotionEvidenceWindow w=new MotionEvidenceWindow();check(w.snapshot(30_000_000_000L).state.equals("unknown"),"missing");
  for(int i=0;i<=150;i++)w.add(i*200_000_000L,.02);
  check(w.snapshot(30_000_000_000L).state.equals("quiet"),"quiet");
  w.add(30_200_000_000L,.8);check(w.snapshot(30_200_000_000L).state.equals("moving"),"pickup");
  check(w.snapshot(90_000_000_000L).state.equals("unknown"),"stale");w.clear();
  for(int i=0;i<=150;i++){if(i<40||i>70)w.add(i*200_000_000L,.02);}
  check(w.snapshot(30_000_000_000L).state.equals("unknown"),"gap");w.clear();
  for(int i=0;i<20000;i++)w.add(i*200_000_000L,.02);
  check(w.snapshot(19_999*200_000_000L).samples<=151,"bounded window");
  w.add(0,99);check(w.snapshot(19_999*200_000_000L).state.equals("quiet"),"old event ignored");
  w.clear();check(w.snapshot(30_000_000_000L).state.equals("unknown"),"session cleanup");
  // Reproduce the real device: ~53Hz used to truncate the required window to 18.8 seconds.
  for(long step:new long[]{20_000_000L,18_883_000L,5_000_000L,1_000_000L}){
   w.clear();for(long t=0;t<=60_000_000_000L;t+=step)w.add(t,.02);
   MotionEvidenceWindow.Result r=w.snapshot(59_900_000_000L);
   check(r.state.equals("quiet"),"high-rate quiet "+step);
   check(r.spanMs>=29000&&r.samples<=151,"time coverage bounded "+step);
   check(r.rawSamples>r.samples,"raw count retained "+step);
  }
  w.clear();for(long t=0;t<=30_000_000_000L;t+=5_000_000L)w.add(t,t==15_005_000_000L?.8:.02);
  check(w.snapshot(30_000_000_000L).state.equals("moving"),"short peak not averaged away");
  check(w.snapshot(30_000_000_000L).peak==.8,"peak retained");
  w.clear();for(long t=0;t<=30_000_000_000L;t+=20_000_000L)if(t<10_000_000_000L||t>12_000_000_000L)w.add(t,.02);
  check(w.snapshot(30_000_000_000L).state.equals("unknown"),"high-rate real gap stays unknown");
  w.clear();for(long t=0;t<=30_000_000_000L;t+=20_000_000L)w.add(t,t>=10_100_000_000L?.02:.8);
  check(w.snapshot(10_050_000_000L).state.equals("unknown"),"partial future bin cannot fill coverage");
  check(w.snapshot(10_050_000_000L).peak==.8,"future does not overwrite earlier motion");
  w.clear();for(long t=0;t<=30_000_000_000L;t+=20_000_000L)w.add(t,9.806);
  check(w.snapshot(30_000_000_000L).gravityLike(),"gravity-like window flagged");
  check(w.snapshot(30_000_000_000L).validatedState(3).equals("unknown"),"high accuracy cannot validate gravity-like output");
  w.clear();for(long t=0;t<=30_000_000_000L;t+=20_000_000L)w.add(t,.02);
  check(w.snapshot(30_000_000_000L).validatedState(0).equals("unknown"),"unreliable never quiet");
  check(w.snapshot(30_000_000_000L).validatedState(-1).equals("unknown"),"invalid negative accuracy");
  check(w.snapshot(30_000_000_000L).validatedState(99).equals("unknown"),"invalid accuracy");
  check(w.snapshot(30_000_000_000L).validatedState(3).equals("quiet"),"valid covered low acceleration");
  System.out.println("PASS");
 }
}`);
  execFileSync('javac',['-d',dir,resolve('tests/diagnostics/native/MotionEvidenceWindow.java'),harness]);assert.equal(execFileSync('java',['-cp',dir,'expo.modules.location.taskConsumers.MotionTest'],{encoding:'utf8'}).trim(),'PASS');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
