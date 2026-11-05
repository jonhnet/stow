package net.stowapp.android;

import android.content.*;
import androidx.work.WorkManager;

/** Debug APK only; shell-privileged emulator harness, never shipped in release. */
public final class EmulatorControl extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        try {
            DeviceState state = new DeviceState(context);
            switch (intent.getStringExtra("command")) {
                case "refresh" -> { state.success(0); Scheduler.request(context, "emulator-request"); }
                case "age" -> state.success(0);
                case "deferred" -> {
                    state.success(0);
                    WorkManager.getInstance(context).enqueueUniqueWork("stow-doze-test", androidx.work.ExistingWorkPolicy.KEEP,
                        new androidx.work.OneTimeWorkRequest.Builder(RefreshWorker.class).setConstraints(Scheduler.CONNECTED)
                            .setInitialDelay(5, java.util.concurrent.TimeUnit.SECONDS)
                            .setInputData(new androidx.work.Data.Builder().putString("trigger", "emulator-delayed").build()).build());
                }
                case "cancel" -> WorkManager.getInstance(context).cancelAllWork();
                case "register" -> { state.success(0); Scheduler.register(context); }
                case "periodic" -> {
                    state.success(0);
                    WorkManager.getInstance(context).enqueueUniquePeriodicWork(Scheduler.PERIODIC,
                        androidx.work.ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE, Scheduler.periodicRequest());
                }
                case "inspect" -> {
                    PendingResult result = goAsync();
                    new Thread(() -> {
                        try {
                            org.json.JSONObject report = new org.json.JSONObject().put("at", System.currentTimeMillis()).put("lastSuccess", state.lastSuccess()).put("events", state.events());
                            org.json.JSONArray jobs = new org.json.JSONArray();
                            for (var info : WorkManager.getInstance(context).getWorkInfosForUniqueWork(Scheduler.PERIODIC).get()) {
                                jobs.put(new org.json.JSONObject().put("id", info.getId()).put("state", info.getState()).put("attempt", info.getRunAttemptCount()).put("nextAt", info.getNextScheduleTimeMillis()));
                            }
                            report.put("periodic", jobs);
                            java.nio.file.Files.write(new java.io.File(context.getFilesDir(), "emulator-work.json").toPath(), report.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            result.setResultCode(0);
                        } catch (Exception e) { android.util.Log.e("StowControl", "Inspection failed", e); result.setResultCode(1); }
                        finally { result.finish(); }
                    }).start();
                    return;
                }
            }
            setResultCode(0);
        } catch (Exception e) { android.util.Log.e("StowControl", "Emulator control failed", e); setResultCode(1); }
    }
}
