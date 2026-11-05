package net.stowapp.android;

import android.app.ActivityManager;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.net.*;
import android.os.*;
import org.json.JSONObject;

/** Observe the app's network policy, not just whether a radio is connected.
 * The callback belongs to one bounded worker; it never schedules extra work. */
final class RefreshDiagnostics implements AutoCloseable {
    private final Context context;
    private final ConnectivityManager connectivity;
    private Network observed;
    private Boolean blocked;
    private final ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) { synchronized (RefreshDiagnostics.this) { observed = network; blocked = null; } }
        @Override public void onLost(Network network) { synchronized (RefreshDiagnostics.this) { if (network.equals(observed)) { observed = null; blocked = null; } } }
        @Override public void onBlockedStatusChanged(Network network, boolean value) { synchronized (RefreshDiagnostics.this) { observed = network; blocked = value; } }
    };
    RefreshDiagnostics(Context context) {
        this.context = context;
        connectivity = context.getSystemService(ConnectivityManager.class);
        connectivity.registerDefaultNetworkCallback(callback);
    }
    synchronized JSONObject snapshot() {
        try {
            PowerManager power = context.getSystemService(PowerManager.class);
            Network active = connectivity.getActiveNetwork();
            NetworkCapabilities caps = active == null ? null : connectivity.getNetworkCapabilities(active);
            LinkProperties link = active == null ? null : connectivity.getLinkProperties(active);
            // Unknown is explicit (including APIs absent on older supported OSes).
            JSONObject network = new JSONObject().put("present", active != null)
                .put("blocked", blocked == null ? JSONObject.NULL : blocked)
                .put("observed", observed != null)
                .put("validated", caps == null ? JSONObject.NULL : caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                .put("metered", caps == null ? JSONObject.NULL : !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
                .put("suspended", caps == null ? JSONObject.NULL : !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED))
                .put("wifi", caps == null ? JSONObject.NULL : caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
                .put("cellular", caps == null ? JSONObject.NULL : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))
                .put("vpn", caps == null ? JSONObject.NULL : caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
                .put("privateDns", link == null ? JSONObject.NULL : link.isPrivateDnsActive());
            return new JSONObject().put("sdk", Build.VERSION.SDK_INT)
                .put("charging", context.getSystemService(BatteryManager.class).isCharging())
                .put("interactive", power.isInteractive()).put("idle", power.isDeviceIdleMode())
                .put("lightIdle", Build.VERSION.SDK_INT >= 33 ? power.isDeviceLightIdleMode() : JSONObject.NULL)
                .put("powerSave", power.isPowerSaveMode())
                .put("lowPowerStandby", Build.VERSION.SDK_INT >= 33 ? power.isLowPowerStandbyEnabled() : JSONObject.NULL)
                .put("standbyExempt", Build.VERSION.SDK_INT >= 34 ? power.isExemptFromLowPowerStandby() : JSONObject.NULL)
                .put("batteryExempt", power.isIgnoringBatteryOptimizations(context.getPackageName()))
                .put("backgroundRestricted", context.getSystemService(ActivityManager.class).isBackgroundRestricted())
                .put("standbyBucket", context.getSystemService(UsageStatsManager.class).getAppStandbyBucket())
                .put("dataSaver", connectivity.getRestrictBackgroundStatus()).put("network", network);
        } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
    }
    void event(DeviceState state, String trigger, String message) {
        state.event(trigger, bounded(message) + " | state=" + snapshot());
    }
    static String failure(Throwable error) {
        StringBuilder message = new StringBuilder();
        for (Throwable cause = error; cause != null && message.length() < 240; cause = cause.getCause()) {
            if (message.length() > 0) message.append(" <- ");
            message.append(cause.getClass().getSimpleName()).append(": ").append(cause.getMessage());
        }
        return bounded(message.toString());
    }
    private static String bounded(String value) { return value.length() > 280 ? value.substring(0, 280) : value; }
    @Override public void close() { connectivity.unregisterNetworkCallback(callback); }
}
