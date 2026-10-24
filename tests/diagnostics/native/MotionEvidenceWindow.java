package expo.modules.location.taskConsumers;

import java.util.ArrayDeque;

/** Time-bounded evidence. Preserve peaks and gaps even when delivery exceeds the requested rate. */
public final class MotionEvidenceWindow {
  private static final long WINDOW = 30_000_000_000L;
  private static final long BUCKET = 200_000_000L;
  private static final class Bin {
    final long key, first; long last, maxGap; int count; double squares, peak;
    Bin(long t,double m){key=t/BUCKET;first=t;last=t;count=1;squares=m*m;peak=m;}
    void add(long t,double m){maxGap=Math.max(maxGap,t-last);last=t;count++;squares+=m*m;peak=Math.max(peak,m);}
  }
  private final ArrayDeque<Bin> bins = new ArrayDeque<>();
  public synchronized void add(long time,double magnitude) {
    if(time<0 || !Double.isFinite(magnitude) || magnitude<0 || magnitude>10000) return;
    Bin last=bins.peekLast();
    if(last!=null && time<=last.last) return;
    if(last!=null && last.key==time/BUCKET)last.add(time,magnitude);else bins.addLast(new Bin(time,magnitude));
    while(bins.size()>1000 || (!bins.isEmpty() && time-bins.peekFirst().first>180_000_000_000L)) bins.removeFirst();
  }
  public synchronized void clear(){bins.clear();}
  public synchronized Result snapshot(long end) {
    int count=0,raw=0;long first=0,last=0,maxGap=0;double sum=0,peak=0;
    // Partial bins straddling the observation boundary are excluded, never borrowing future evidence.
    for(Bin b:bins){if(b.first<end-WINDOW || b.last>end)continue;
      if(count==0)first=b.first;else maxGap=Math.max(maxGap,b.first-last);
      maxGap=Math.max(maxGap,b.maxGap);last=b.last;count++;raw+=b.count;sum+=b.squares;peak=Math.max(peak,b.peak);
    }
    long span=count>1?last-first:0;
    if(count>0)maxGap=Math.max(maxGap,Math.max(first-(end-WINDOW),end-last));
    double rms=raw>0?Math.sqrt(sum/raw):0;
    String state=count>=80 && span>=24_000_000_000L && maxGap<=1_000_000_000L ? (rms<=0.08 && peak<=0.25 ? "quiet" : "moving") : "unknown";
    return new Result(state,count,raw,span/1_000_000L,maxGap/1_000_000L,rms,peak);
  }
  public static final class Result {
    public final String state; public final int samples, rawSamples; public final long spanMs,maxGapMs; public final double rms,peak;
    public boolean gravityLike(){return spanMs>=24000 && rms>=8.0 && rms<=11.0 && peak>=8.0 && peak<=12.0;}
    public String validatedState(int accuracy){return accuracy<1 || accuracy>3 || gravityLike() ? "unknown" : state;}
    Result(String s,int n,int raw,long span,long gap,double r,double p){state=s;samples=n;rawSamples=raw;spanMs=span;maxGapMs=gap;rms=r;peak=p;}
  }
}
