package net.stowapp.android;

import android.content.Context;
import android.os.*;
import androidx.annotation.NonNull;
import androidx.work.*;
import org.json.JSONObject;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

public final class RefreshWorker extends Worker {
    private static final ReentrantLock ACTIVE = new ReentrantLock();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CountDownLatch finished = new CountDownLatch(1);
    private final AtomicBoolean done = new AtomicBoolean();
    private volatile WebHost host;
    private volatile RefreshDiagnostics diagnostics;
    private volatile boolean success;
    public RefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    @NonNull @Override public Result doWork() {
        DeviceState state = new DeviceState(getApplicationContext());
        if (!state.paired()) return Result.failure();
        String trigger = getInputData().getString("trigger");
        if (!ACTIVE.tryLock()) { state.event(trigger, "worker: another refresh is running"); return Result.success(); }
        try {
            diagnostics = new RefreshDiagnostics(getApplicationContext());
            diagnostics.event(state, trigger, "worker started: " + trigger + "; attempt=" + getRunAttemptCount());
            long age = System.currentTimeMillis() - state.lastSuccess();
            if (age >= 0 && age < 5 * 60 * 1000L) { state.event(trigger, "worker: recent success; coalesced"); return Result.success(); }
            ReleaseStore releases = new ReleaseStore(getApplicationContext());
            String release = releases.active();
            if (release.isEmpty()) { state.event(trigger, "worker skipped: open Stow to finish initial download"); return Result.failure(); }
            main.post(() -> {
                if (isStopped() || done.get()) { finished.countDown(); return; }
                try {
                    host = new WebHost(getApplicationContext(), release, true, trigger, new WebHost.Listener() {
                        public void message(JSONObject message) {
                            if (!"refresh-complete".equals(message.optString("type"))) return;
                            success = message.optBoolean("ok");
                            if (success) state.success(message.optLong("completedAt"));
                            diagnostics.event(state, trigger, success ? "worker refresh saved" : "worker refresh failed: " + message.optString("error", "Refresh did not complete"));
                            finished.countDown();
                        }
                        public void failure(String reason) { diagnostics.event(state, trigger, "worker renderer failure: " + reason); finished.countDown(); }
                    });
                } catch (Exception e) { diagnostics.event(state, trigger, "worker launch failure: " + RefreshDiagnostics.failure(e)); finished.countDown(); }
            });
            if (!finished.await(70, TimeUnit.SECONDS)) diagnostics.event(state, trigger, "worker refresh timed out");
            done.set(true); main.post(this::destroyHost);
            // An update check cannot turn a successfully saved note into failure.
            if (!isStopped()) try { releases.check(state.origin()); state.event(trigger, "worker update check completed"); }
            catch (Exception e) { diagnostics.event(state, trigger, "worker update check failed: " + RefreshDiagnostics.failure(e)); }
            // This bounded polling opportunity is finished, even if networking
            // failed. Only the durable refresh path above records sync success.
            // Result.retry() would back off the periodic job for hours, making
            // it ineligible during intervening Android maintenance windows.
            return Result.success();
        } catch (Exception e) {
            if (diagnostics != null) diagnostics.event(state, trigger, "worker failed: " + RefreshDiagnostics.failure(e));
            else state.event(trigger, "worker failed: " + RefreshDiagnostics.failure(e));
            return Result.success();
        } finally { done.set(true); main.post(this::destroyHost); if (diagnostics != null) diagnostics.close(); ACTIVE.unlock(); }
    }
    private void destroyHost() { if (host != null) { host.destroy(); host = null; } }
    @Override public void onStopped() {
        done.set(true);
        DeviceState state = new DeviceState(getApplicationContext());
        String message = "worker stopped by Android; stopReason=" + (Build.VERSION.SDK_INT >= 31 ? getStopReason() : "unknown") + "; saved writes retained";
        if (diagnostics != null) diagnostics.event(state, getInputData().getString("trigger"), message);
        else state.event(getInputData().getString("trigger"), message);
        finished.countDown(); main.post(this::destroyHost);
    }
}
