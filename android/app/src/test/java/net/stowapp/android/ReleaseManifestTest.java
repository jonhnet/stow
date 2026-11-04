package net.stowapp.android;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ReleaseManifestTest {
    static JSONObject manifest() throws Exception {
        JSONObject file = new JSONObject().put("bytes", 12).put("sha256", "a".repeat(64));
        return new JSONObject().put("format", 1).put("release", "b".repeat(64)).put("minimumShellApi", 1)
            .put("files", new JSONObject().put("/index.html", file).put("/background.html", file));
    }
    @Test public void completeAndFutureApiAreValidButUnsafePathsAreNot() throws Exception {
        ReleaseManifest.validate(manifest()); ReleaseManifest.validate(manifest().put("minimumShellApi", 2));
        for (String path : new String[]{"../secret", "/../secret", "/x/../../secret", "/%2e%2e/secret", "/api/session", "/native/api/session", "/x//file", "https://evil/file"}) {
            JSONObject value = manifest(); value.getJSONObject("files").put(path, value.getJSONObject("files").get("/index.html"));
            assertThrows(path, Exception.class, () -> ReleaseManifest.validate(value));
        }
    }
    @Test public void incompleteOversizedAndMalformedBundlesFailClosed() throws Exception {
        JSONObject missing = manifest(); missing.getJSONObject("files").remove("/background.html");
        assertThrows(Exception.class, () -> ReleaseManifest.validate(missing));
        JSONObject huge = manifest(); huge.getJSONObject("files").getJSONObject("/index.html").put("bytes", 9 * 1024 * 1024);
        assertThrows(Exception.class, () -> ReleaseManifest.validate(huge));
        assertThrows(Exception.class, () -> ReleaseManifest.validate(manifest().put("format", 2)));
        assertThrows(Exception.class, () -> ReleaseManifest.validate(manifest().put("release", "../installed")));
        assertThrows(Exception.class, () -> ReleaseManifest.validate(manifest().put("android", new JSONObject().put("version", 2).put("minSdk", 28).put("url", "https://other/app.apk").put("sha256", "a".repeat(64)))));
    }
}
