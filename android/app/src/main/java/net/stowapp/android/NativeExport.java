package net.stowapp.android;

import android.content.Context;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.util.Set;

/** One bounded, user-requested export. Destinations are chosen through Android. */
final class NativeExport {
    private final File file;
    private FileOutputStream output;
    private long expected, received;
    private int sequence;
    String filename, mime;
    NativeExport(Context context) { file = new File(context.getCacheDir(), "stow-export.tmp"); }
    void start(JSONObject message) throws Exception {
        if (output != null) throw new IOException("An export is already in progress");
        expected = message.getLong("bytes"); received = 0; sequence = 0;
        if (expected < 0 || expected > 64L * 1024 * 1024) throw new IOException("Export is too large");
        filename = message.getString("filename").replaceAll("[\\p{Cntrl}/\\\\]", "-");
        mime = message.getString("mime");
        if (filename.length() > 200 || !Set.of("application/json", "text/plain", "text/markdown", "text/html").contains(mime)) throw new IOException("Invalid export format");
        output = new FileOutputStream(file);
    }
    void chunk(JSONObject message) throws Exception {
        if (output == null || message.getInt("sequence") != sequence++) throw new IOException("Export was interrupted");
        byte[] bytes = Base64.decode(message.getString("data"), Base64.NO_WRAP);
        received += bytes.length;
        if (received > expected) throw new IOException("Export exceeded its declared size");
        output.write(bytes);
    }
    File finish() throws Exception {
        if (output == null || received != expected) throw new IOException("Export is incomplete");
        output.getFD().sync(); output.close(); output = null; return file;
    }
    void cancel() { try { if (output != null) output.close(); } catch (IOException ignored) {} output = null; file.delete(); }
}
