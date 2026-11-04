package net.stowapp.android;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class DeviceStateTest {
    @Test public void nativeDiagnosticsKeepTheirOriginalTriggerAcrossLaterWakes() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        var preferences = context.getSharedPreferences("device", Context.MODE_PRIVATE);
        preferences.edit().clear().commit();
        try {
            new DeviceState(context).event("network", "refresh requested");
            new DeviceState(context).event("periodic", "worker started");
            var events = new DeviceState(context).events();
            assertEquals("network", events.getJSONObject(0).getString("trigger"));
            assertEquals("periodic", events.getJSONObject(1).getString("trigger"));
            assertEquals(BuildConfig.VERSION_CODE, events.getJSONObject(0).getInt("shellVersion"));
        } finally { preferences.edit().clear().commit(); }
    }
    @Test public void malformedOrDifferentIdentityCannotReplaceTheSavedAccount() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        var preferences = context.getSharedPreferences("device", Context.MODE_PRIVATE);
        JSONObject account = new JSONObject().put("user", "alice").put("vaultId", "alice-vault-private-1234").put("authMode", "proxy");
        preferences.edit().clear().putString("origin", "https://stow.example").putString("account", account.toString()).putString("token", "a".repeat(64)).commit();
        DeviceState state = new DeviceState(context);
        try {
            JSONObject grant = new JSONObject().put("account", new JSONObject(account.toString()).put("user", "bob")).put("token", "b".repeat(64));
            assertThrows(Exception.class, () -> state.pair("https://stow.example", grant));
            assertEquals(account.toString(), state.account()); assertEquals("a".repeat(64), state.token());
            grant.getJSONObject("account").remove("vaultId");
            assertThrows(Exception.class, () -> state.pair("https://stow.example", grant));
            assertEquals(account.toString(), state.account());
        } finally { preferences.edit().clear().commit(); }
    }
}
