package expo.modules.location.taskConsumers

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import kotlin.math.sqrt

/** Diagnostic only: compare independent implementations without calibrating away observed movement. */
class MotionEvidenceCollector(context: Context) : SensorEventListener {
  private val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  private data class Stream(val sensor: Sensor, val window: MotionEvidenceWindow = MotionEvidenceWindow(), var accuracy: Int = SensorManager.SENSOR_STATUS_UNRELIABLE)
  private val streams = mutableListOf<Stream>()
  private var primary: Stream? = null
  private var rawSensor: Sensor? = null
  private var rawAccuracy = SensorManager.SENSOR_STATUS_UNRELIABLE
  private val rawEvidence = RawMotionEvidence()
  private var availability = JSONObject().put("status","not_started")
  companion object {
    @Volatile var foregroundDiagnosticsEnabled = false
    private val active = java.util.concurrent.atomic.AtomicReference<java.lang.ref.WeakReference<MotionEvidenceCollector>?>(null)
    fun foregroundQuality(location: android.location.Location): String? {
      if(!foregroundDiagnosticsEnabled)return null
      return try { locationQuality(location,active.get()?.get()?.snapshot(location.elapsedRealtimeNanos) ?: JSONObject().put("state","unknown").put("rawAccelerometer",JSONObject().put("state","unknown")).put("availability",JSONObject().put("status","no_active_recording_collector")),"foreground").toString() }
        catch(_:Exception) { null }
    }
    fun locationQuality(location: android.location.Location,motion:JSONObject,source:String):JSONObject =
      JSONObject().put("evidenceSchema","aclog_quality_v2").put("source",source)
        .put("latitude",location.latitude).put("longitude",location.longitude)
        .put("fixTimeMs",location.time).put("fixElapsedRealtimeNanos",location.elapsedRealtimeNanos.toString())
        .put("observedWallTimeMs",System.currentTimeMillis()).put("observedElapsedRealtimeNanos",android.os.SystemClock.elapsedRealtimeNanos().toString())
        .put("hasSpeed",location.hasSpeed()).put("reportedSpeed",if(location.hasSpeed())location.speed.toDouble() else JSONObject.NULL)
        .put("hasHorizontalAccuracy",location.hasAccuracy()).put("horizontalAccuracy",if(location.hasAccuracy())location.accuracy.toDouble() else JSONObject.NULL)
        .put("hasSpeedAccuracy",android.os.Build.VERSION.SDK_INT>=26 && location.hasSpeedAccuracy())
        .put("speedAccuracy",if(android.os.Build.VERSION.SDK_INT>=26 && location.hasSpeedAccuracy())location.speedAccuracyMetersPerSecond.toDouble() else JSONObject.NULL)
        .put("provider",location.provider ?: "unknown").put("mock",if(android.os.Build.VERSION.SDK_INT>=31)location.isMock else location.isFromMockProvider)
        .put("fixAgeMs",(android.os.SystemClock.elapsedRealtimeNanos()-location.elapsedRealtimeNanos)/1_000_000).put("motion",motion)
    private fun identity(sensor: Sensor) = JSONObject().put("name",sensor.name).put("vendor",sensor.vendor)
      .put("version",sensor.version).put("type",sensor.type).put("id",sensor.id)
      .put("minDelayUs",sensor.minDelay).put("wakeUp",sensor.isWakeUpSensor)
    /** Public app-visible inventory. Registration accepted does not mean delivered/valid movement data. */
    fun probeInventory(context: Context): String {
      val sm=context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        ?: return JSONObject().put("status","manager_unavailable").toString()
      val sensors=try { sm.getSensorList(Sensor.TYPE_LINEAR_ACCELERATION).take(16) }
        catch(e:Exception) { return JSONObject().put("status","enumeration_exception").put("errorType",e.javaClass.simpleName).toString() }
      val standard=try { sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) } catch(_:Exception) { null }
      val attempts=org.json.JSONArray()
      for(sensor in sensors) {
        val row=identity(sensor).put("isDefault",sensor===standard)
        val probe=object: SensorEventListener {
          override fun onSensorChanged(event: SensorEvent) {}
          override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
        }
        try { row.put("registrationAccepted",sm.registerListener(probe,sensor,200_000,Handler(Looper.getMainLooper()))) }
        catch(e:Exception) { row.put("registrationAccepted",false).put("errorType",e.javaClass.simpleName) }
        finally {
          try { sm.unregisterListener(probe) } catch(e:Exception) { row.put("cleanupErrorType",e.javaClass.simpleName) }
        }
        attempts.put(row.put("deliveryChecked",false))
      }
      return JSONObject().put("status","public_inventory_probed").put("linearSensorCount",sensors.size)
        .put("probeMode","register_unregister_no_sampling_wait").put("sensors",attempts).toString()
    }
  }
  @Synchronized fun start() {
    active.set(java.lang.ref.WeakReference(this))
    if (primary != null || rawSensor != null) return
    val available=manager?.getSensorList(Sensor.TYPE_LINEAR_ACCELERATION) ?: return
    val attempts=org.json.JSONArray()
    availability=JSONObject().put("status","enumerated").put("publicLinearSensorCount",available.size)
      .put("visibleSensors",org.json.JSONArray(available.take(16).map { identity(it) })).put("attempts",attempts)
    val standard=manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    // AOSP is a secondary implementation; record identity and compare with the vendor default.
    val secondary=available.firstOrNull { it.version==3 && (it.vendor=="AOSP" || it.vendor.startsWith("Google")) }
    // Also consider other publicly exposed implementations; do not assume vendor/version names are universal.
    val choices=(listOfNotNull(secondary,standard)+available).distinct().take(3)
    for(sensor in choices) {
      val stream=Stream(sensor)
      val attempt=identity(sensor)
      val registered=try { manager.registerListener(this,sensor,200_000,Handler(Looper.getMainLooper())) }
        catch (e: Exception) { attempt.put("errorType",e.javaClass.simpleName); false }
      attempts.put(attempt.put("registrationAccepted",registered))
      if(registered) {
        streams.add(stream)
        if(primary==null)primary=stream
      }
    }
    // The physical accelerometer includes gravity; process it independently of vendor linear fusion.
    val rawAttempt=JSONObject().put("status","unavailable")
    availability.put("rawAccelerometer",rawAttempt)
    try {
      val sensor=manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
      if(sensor!=null && sensor.type==Sensor.TYPE_ACCELEROMETER) {
        rawAttempt.put("sensor",identity(sensor))
        val accepted=manager.registerListener(this,sensor,50_000,Handler(Looper.getMainLooper()))
        rawAttempt.put("status",if(accepted)"registered" else "registration_rejected")
        if(accepted)rawSensor=sensor
      }
    } catch(e:Exception) {rawAttempt.put("status","registration_exception").put("errorType",e.javaClass.simpleName)}
  }
  @Synchronized fun stop() {
    val current=active.get();if(current?.get()===this)active.compareAndSet(current,null)
    try { manager?.unregisterListener(this) } catch (_: Exception) { /* Optional evidence cannot stop location cleanup. */ }
    finally { for(s in streams)s.window.clear(); streams.clear(); primary=null; rawSensor=null; rawAccuracy=SensorManager.SENSOR_STATUS_UNRELIABLE; rawEvidence.clear() }
  }
  @Synchronized override fun onAccuracyChanged(sensor: Sensor?, value: Int) { streams.firstOrNull { it.sensor===sensor }?.accuracy=value; if(sensor===rawSensor)rawAccuracy=value }
  @Synchronized override fun onSensorChanged(event: SensorEvent) {
    if(event.values.size<3)return
    if(rawSensor!=null && event.sensor===rawSensor) {
      rawAccuracy=event.accuracy
      rawEvidence.add(event.timestamp,event.values[0].toDouble(),event.values[1].toDouble(),event.values[2].toDouble())
      return
    }
    if(event.sensor.type!=Sensor.TYPE_LINEAR_ACCELERATION)return
    val s=streams.firstOrNull { it.sensor===event.sensor } ?: return
    val x=event.values[0].toDouble();val y=event.values[1].toDouble();val z=event.values[2].toDouble()
    s.accuracy=event.accuracy
    s.window.add(event.timestamp,sqrt(x*x+y*y+z*z))
  }
  private fun describe(s: Stream?, end: Long): JSONObject {
    val r=(s?.window ?: MotionEvidenceWindow()).snapshot(end)
    val gravityLike=r.gravityLike()
    return JSONObject().put("state",r.validatedState(s?.accuracy ?: SensorManager.SENSOR_STATUS_UNRELIABLE))
      .put("samples",r.samples).put("rawSamples",r.rawSamples).put("sampleUnit","200ms_bucket")
      .put("spanMs",r.spanMs).put("maxGapMs",r.maxGapMs).put("rms",r.rms).put("peak",r.peak)
      .put("windowMs",30_000).put("sensorAccuracy",s?.accuracy ?: SensorManager.SENSOR_STATUS_UNRELIABLE)
      .put("gravityLike",gravityLike).put("sensorName",s?.sensor?.name ?: "unavailable")
      .put("sensorVendor",s?.sensor?.vendor ?: "unavailable").put("sensorVersion",s?.sensor?.version ?: 0)
      .put("sensorId",s?.sensor?.id ?: -1).put("sensorMinDelayUs",s?.sensor?.minDelay ?: 0)
  }
  @Synchronized fun snapshot(endNanos: Long): JSONObject {
    val result=describe(primary,endNanos)
    val raw=rawEvidence.snapshot(endNanos,rawAccuracy)
    result.put("rawAccelerometer",JSONObject().put("state",raw.state).put("assessment","positive_motion_only")
      .put("sensorName",rawSensor?.name ?: "unavailable").put("sensorVendor",rawSensor?.vendor ?: "unavailable")
      .put("sensorAccuracy",rawAccuracy).put("samples",raw.residual.samples).put("rawSamples",raw.residual.rawSamples)
      .put("spanMs",raw.residual.spanMs).put("maxGapMs",raw.residual.maxGapMs).put("rms",raw.residual.rms)
      .put("peak",raw.residual.peak).put("rawRmsIncludingGravity",raw.raw.rms)
      .put("gravityEstimateNorm",raw.gravityEstimateNorm).put("warmupMs",10000).put("windowMs",30000))
    result.put("availability",availability)
    result.put("comparison",org.json.JSONArray(streams.filter { it!==primary }.map { describe(it,endNanos) }))
    return result
  }
}
