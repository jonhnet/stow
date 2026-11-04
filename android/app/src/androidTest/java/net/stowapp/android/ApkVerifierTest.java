package net.stowapp.android;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class ApkVerifierTest {
    @Test public void packageVersionAndSignatureMustAllMatch() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        var manager = context.getPackageManager();
        String name = context.getPackageName();
        File actual = new File(context.getApplicationInfo().sourceDir);
        ApkVerifier.verify(manager, name, actual, BuildConfig.VERSION_CODE);
        assertThrows(Exception.class, () -> ApkVerifier.verify(manager, name, actual, BuildConfig.VERSION_CODE + 1));
        // The instrumentation APK uses the same debug key but a different package.
        File other = new File(manager.getApplicationInfo(name + ".test", 0).sourceDir);
        assertThrows(Exception.class, () -> ApkVerifier.verify(manager, name, other, BuildConfig.VERSION_CODE));
        File bad = new File(context.getCacheDir(), "bad.apk"); ReleaseStore.write(bad, "not an APK".getBytes());
        assertThrows(Exception.class, () -> ApkVerifier.verify(manager, name, bad, BuildConfig.VERSION_CODE));
        bad.delete();
    }
}
