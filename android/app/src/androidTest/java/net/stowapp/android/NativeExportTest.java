package net.stowapp.android;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import android.util.Base64;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeExportTest {
    @Test public void exportsPreserveBytesAndRejectTruncatedOrOutOfOrderMessages() throws Exception {
        NativeExport export = new NativeExport(ApplicationProvider.getApplicationContext());
        byte[] text = "Flight ✈️\nTwo lines\n".getBytes(StandardCharsets.UTF_8);
        JSONObject start = new JSONObject().put("filename", "flight.md").put("mime", "text/markdown").put("bytes", text.length);
        try {
            export.start(start);
            export.chunk(new JSONObject().put("sequence", 0).put("data", Base64.encodeToString(text, Base64.NO_WRAP)));
            assertArrayEquals(text, Files.readAllBytes(export.finish().toPath()));
            export.start(start);
            assertThrows(Exception.class, export::finish); export.cancel();
            export.start(start);
            assertThrows(Exception.class, () -> export.chunk(new JSONObject().put("sequence", 1).put("data", "YQ=="))); export.cancel();
            assertThrows(Exception.class, () -> export.start(new JSONObject(start.toString()).put("bytes", 65L * 1024 * 1024)));
        } finally { export.cancel(); }
    }
}
