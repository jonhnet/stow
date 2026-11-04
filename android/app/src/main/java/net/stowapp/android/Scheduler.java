package net.stowapp.android;

import android.app.PendingIntent;
import android.content.*;
import android.net.*;
import androidx.work.*;
import java.util.concurrent.TimeUnit;

final class Scheduler {
    static final String PERIODIC = "stow-periodic-refresh";
    static final String NETWORK = "net.stowapp.android.NETWORK_AVAILABLE";
    static final Constraints CONNECTED = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    static void register(Context context) {
        if (!new DeviceState(context).paired()) return;
        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(RefreshWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(CONNECTED).setInputData(new Data.Builder().putString("trigger", "periodic").build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag("stow-refresh").build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic);
        Intent intent = new Intent(context, RefreshReceiver.class).setAction(NETWORK);
        PendingIntent callback = PendingIntent.getBroadcast(context, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        manager.registerNetworkCallback(new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED).build(), callback);
    }
    static void request(Context context, String trigger) {
        DeviceState state = new DeviceState(context); if (!state.paired()) return;
        long age = System.currentTimeMillis() - state.lastSuccess();
        if (age >= 0 && age < TimeUnit.MINUTES.toMillis(5)) { state.event(trigger, trigger + ": recent successful refresh; coalesced"); return; }
        state.event(trigger, trigger + ": refresh requested");
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(RefreshWorker.class).setConstraints(CONNECTED)
            .setInputData(new Data.Builder().putString("trigger", trigger).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag("stow-refresh").build();
        WorkManager.getInstance(context).enqueueUniqueWork("stow-opportunistic-refresh", ExistingWorkPolicy.KEEP, request);
    }
}
