package net.stowapp.android;
import android.content.*;
public final class RefreshReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!new DeviceState(context).paired()) return;
        if (!Scheduler.NETWORK.equals(intent.getAction())) Scheduler.register(context);
        Scheduler.request(context, Scheduler.NETWORK.equals(intent.getAction()) ? "network" : "boot");
    }
}
