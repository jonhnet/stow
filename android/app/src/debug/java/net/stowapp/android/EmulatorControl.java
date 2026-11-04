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
            }
            setResultCode(0);
        } catch (Exception e) { android.util.Log.e("StowControl", "Emulator control failed", e); setResultCode(1); }
    }
}
