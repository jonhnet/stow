package net.stowapp.android;
import android.app.Application;
public final class StowApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        try { new ReleaseStore(this).collect(); Scheduler.register(this); }
        catch (Exception e) { new DeviceState(this).event("startup: " + e.getMessage()); }
    }
}
