package net.stowapp.android;

import android.app.PendingIntent;
import android.content.*;
import android.net.*;
import androidx.work.*;
import java.util.concurrent.TimeUnit;

final class Scheduler {
    // New names retire version 1's persisted, possibly hours-long retry delays.
    static final String PERIODIC = "stow-periodic-refresh-v2";
    static final String OPPORTUNISTIC = "stow-opportunistic-refresh-v2";
    static final String NETWORK = "net.stowapp.android.NETWORK_AVAILABLE";
    static final Constraints CONNECTED = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    static void register(Context context) {
        if (!new DeviceState(context).paired()) return;
        WorkManager work = WorkManager.getInstance(context);
        work.cancelUniqueWork("stow-periodic-refresh");
        work.cancelUniqueWork("stow-opportunistic-refresh");
        work.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodicRequest());
        Intent intent = new Intent(context, RefreshReceiver.class).setAction(NETWORK);
        PendingIntent callback = PendingIntent.getBroadcast(context, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        manager.registerNetworkCallback(new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED).build(), callback);
    }
    static PeriodicWorkRequest periodicRequest() {
        return new PeriodicWorkRequest.Builder(RefreshWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(CONNECTED).setInputData(new Data.Builder().putString("trigger", "periodic").build())
            .addTag("stow-refresh").build();
    }
    static void request(Context context, String trigger) {
        DeviceState state = new DeviceState(context); if (!state.paired()) return;
        long age = System.currentTimeMillis() - state.lastSuccess();
        if (age >= 0 && age < TimeUnit.MINUTES.toMillis(5)) { state.event(trigger, trigger + ": recent successful refresh; coalesced"); return; }
        state.event(trigger, trigger + ": refresh requested");
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(RefreshWorker.class).setConstraints(CONNECTED)
            .setInputData(new Data.Builder().putString("trigger", trigger).build())
            .addTag("stow-refresh").build();
        WorkManager.getInstance(context).enqueueUniqueWork(OPPORTUNISTIC, ExistingWorkPolicy.KEEP, request);
    }
}
