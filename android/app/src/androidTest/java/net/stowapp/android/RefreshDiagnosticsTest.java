package net.stowapp.android;

import android.content.Context;
import android.os.SystemClock;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class RefreshDiagnosticsTest {
    @Test public void powerAndNetworkEvidenceSurvivesTheExistingDiagnosticEnvelope() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        var prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE);
        prefs.edit().clear().commit();
        try (RefreshDiagnostics diagnostics = new RefreshDiagnostics(context)) {
            long deadline = SystemClock.elapsedRealtime() + 5000;
            JSONObject snapshot;
            do {
                snapshot = diagnostics.snapshot();
                if (!snapshot.getJSONObject("network").isNull("blocked")) break;
                SystemClock.sleep(20);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertFalse("Connected emulator must report network policy", snapshot.getJSONObject("network").isNull("blocked"));
            assertTrue(snapshot.has("charging")); assertTrue(snapshot.has("interactive"));
            assertTrue(snapshot.has("idle")); assertTrue(snapshot.has("lowPowerStandby"));
            assertTrue(snapshot.has("dataSaver")); assertTrue(snapshot.has("backgroundRestricted"));
            assertTrue(snapshot.getJSONObject("network").has("privateDns"));
            DeviceState state = new DeviceState(context);
            diagnostics.event(state, "periodic", "worker failed: " + "x".repeat(2000));
            JSONObject event = state.events().getJSONObject(0);
            String message = event.getString("message");
            assertTrue("Web log's 1000-character limit must not truncate state", message.length() <= 1000);
            JSONObject saved = new JSONObject(message.split(" \\| state=", 2)[1]);
            assertEquals(snapshot.getBoolean("charging"), saved.getBoolean("charging"));
            assertEquals("periodic", event.getString("trigger"));
            assertEquals(BuildConfig.VERSION_CODE, event.getInt("shellVersion"));
            assertFalse(message.contains("token")); assertFalse(message.contains("ssid"));
        } finally { prefs.edit().clear().commit(); }
    }
}
