package net.stowapp.android;

import org.json.JSONObject;
import java.util.Iterator;

final class ReleaseManifest {
    static void validate(JSONObject manifest) throws Exception {
        if (manifest.getInt("format") != 1 || !manifest.getString("release").matches("[a-f0-9]{64}") || manifest.getInt("minimumShellApi") < 1) throw new IllegalArgumentException("Invalid Stow release manifest");
        JSONObject files = manifest.getJSONObject("files");
        if (!files.has("/index.html") || !files.has("/background.html") || files.length() > 512) throw new IllegalArgumentException("Incomplete Stow release manifest");
        long total = 0;
        for (Iterator<String> it = files.keys(); it.hasNext();) {
            String path = it.next();
            if (!path.matches("/[a-zA-Z0-9_./-]+") || path.contains("..") || path.contains("//") || path.endsWith("/") || path.startsWith("/api/") || path.startsWith("/native/")) throw new IllegalArgumentException("Invalid release asset path");
            JSONObject file = files.getJSONObject(path); int bytes = file.getInt("bytes");
            if (bytes < 0 || bytes > 8 * 1024 * 1024 || !file.getString("sha256").matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid release asset");
            total += bytes;
        }
        if (total > 32 * 1024 * 1024) throw new IllegalArgumentException("Stow release is too large");
        if (!manifest.isNull("android")) {
            JSONObject apk = manifest.getJSONObject("android");
            if (apk.getInt("version") < 1 || apk.getInt("minSdk") < 28 || !apk.getString("url").matches("/native/android/[a-zA-Z0-9._-]+\\.apk") || !apk.getString("sha256").matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid Android release metadata");
        }
    }
}
