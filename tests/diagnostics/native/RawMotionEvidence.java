package expo.modules.location.taskConsumers;

/** Diagnostic positive motion only. A quiet accelerometer does not establish zero ground speed. */
public final class RawMotionEvidence {
  private final MotionEvidenceWindow raw = new MotionEvidenceWindow();
  private final MotionEvidenceWindow residual = new MotionEvidenceWindow();
  private long last = -1, started = -1;
  private double gx,gy,gz;
  public synchronized void clear(){raw.clear();residual.clear();last=-1;started=-1;gx=gy=gz=0;}
  public synchronized void add(long time,double x,double y,double z){
    if(time<0 || !Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)){clear();return;}
    if(last>=0 && time<=last)return;
    double norm=Math.sqrt(x*x+y*y+z*z);
    if(!Double.isFinite(norm)||norm<1||norm>100){clear();return;}
    if(last>=0 && time-last>1_000_000_000L)clear();
    raw.add(time,norm);
    if(last<0){gx=x;gy=y;gz=z;last=time;started=time;return;}
    double alpha=Math.exp(-((time-last)/1_000_000_000.0)); // 1-second time constant, independent of delivery rate.
    gx=alpha*gx+(1-alpha)*x;gy=alpha*gy+(1-alpha)*y;gz=alpha*gz+(1-alpha)*z;last=time;
    double gravity=Math.sqrt(gx*gx+gy*gy+gz*gz);
    if(gravity<7 || gravity>12){residual.clear();return;}
    if(time-started<10_000_000_000L)return;
    double dx=x-gx,dy=y-gy,dz=z-gz;
    residual.add(time,Math.sqrt(dx*dx+dy*dy+dz*dz));
  }
  public synchronized Result snapshot(long end,int accuracy){
    MotionEvidenceWindow.Result r=residual.snapshot(end), original=raw.snapshot(end);
    double gravity=Math.sqrt(gx*gx+gy*gy+gz*gz);
    String state="unknown";
    if(last>=0 && r.rawSamples>0){
      String assessed=r.validatedState(accuracy);
      if(assessed.equals("moving"))state="motion_observed";
      if(assessed.equals("quiet"))state="no_motion_detected";
    }
    return new Result(state,r,original,gravity);
  }
  public static final class Result {
    public final String state;public final MotionEvidenceWindow.Result residual,raw;public final double gravityEstimateNorm;
    Result(String state,MotionEvidenceWindow.Result residual,MotionEvidenceWindow.Result raw,double gravity){this.state=state;this.residual=residual;this.raw=raw;this.gravityEstimateNorm=gravity;}
  }
}
