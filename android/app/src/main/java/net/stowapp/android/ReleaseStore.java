package net.stowapp.android;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.nio.file.*;
import java.util.*;

final class ReleaseStore {
    private static final Object LOCK = new Object();
    private static final Object DOWNLOAD_LOCK = new Object();
    private final File root;
    private final AtomicFile pointer;
    ReleaseStore(Context context) {
        root = new File(context.getFilesDir(), "web-releases"); root.mkdirs();
        pointer = new AtomicFile(new File(root, "installed.json"));
    }
    private JSONObject pointers() throws Exception {
        if (!pointer.getBaseFile().exists()) return new JSONObject();
        return new JSONObject(new String(pointer.readFully(), java.nio.charset.StandardCharsets.UTF_8));
    }
    private void publish(JSONObject state) throws Exception {
        FileOutputStream out = null;
        try { out = pointer.startWrite(); out.write(state.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); pointer.finishWrite(out); }
        catch (Exception e) { if (out != null) pointer.failWrite(out); throw e; }
    }
    String active() throws Exception { synchronized (LOCK) { return pointers().optString("active"); } }
    JSONObject status() throws Exception { synchronized (LOCK) {
        JSONObject value = pointers();
        return new JSONObject().put("type", "updates").put("active", value.optString("active")).put("pending", value.optString("pending")).put("requiresShell", value.optBoolean("requiresShell")).put("android", value.opt("android"));
    } }
    File directory(String release) {
        if (!release.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid release ID");
        return new File(root, release);
    }
    void check(String origin) throws Exception { synchronized (DOWNLOAD_LOCK) {
        long deadline = android.os.SystemClock.elapsedRealtime() + 120000;
        Http.Reply response = Http.request(origin + "/native/release.json", null, null, 256 * 1024);
        if (response.status() != 200) throw new IOException("Release check failed (HTTP " + response.status() + ")");
        JSONObject manifest = response.json(); ReleaseManifest.validate(manifest);
        String id = manifest.getString("release");
        synchronized (LOCK) {
            JSONObject state = pointers();
            metadata(state, manifest);
            if (state.getBoolean("requiresShell")) { publish(state); return; }
            if (id.equals(state.optString("active"))) { state.remove("pending"); publish(state); return; }
        }
        File destination = directory(id);
        if (!destination.isDirectory()) {
            File stage = new File(root, "stage-" + UUID.randomUUID()); stage.mkdirs();
            try {
                JSONObject files = manifest.getJSONObject("files");
                for (Iterator<String> keys = files.keys(); keys.hasNext();) {
                    if (Thread.currentThread().isInterrupted() || android.os.SystemClock.elapsedRealtime() > deadline) throw new InterruptedIOException("Release download interrupted");
                    String name = keys.next(); JSONObject spec = files.getJSONObject(name);
                    Http.Reply file = Http.request(origin + "/native" + name, null, null, spec.getInt("bytes") + 1);
                    if (file.status() != 200 || file.bytes().length != spec.getInt("bytes") || !Http.hash(file.bytes()).equals(spec.getString("sha256"))) throw new IOException("Release asset failed verification: " + name);
                    File target = new File(stage, name.substring(1)); target.getParentFile().mkdirs();
                    write(target, file.bytes());
                }
                write(new File(stage, "release.json"), response.bytes());
                Files.move(stage.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE);
            } finally { remove(stage); }
        }
        // Re-read after downloading: the UI may have activated a previous
        // pending release while network I/O was in progress. Reads never wait
        // for the download lock, including offline/cold application launches.
        synchronized (LOCK) {
            JSONObject state = pointers(); metadata(state, manifest);
            if (state.optString("active").isEmpty()) state.put("active", id);
            else if (!id.equals(state.optString("active"))) state.put("pending", id);
            publish(state);
        }
    } }
    private static void metadata(JSONObject state, JSONObject manifest) throws Exception {
        state.put("android", manifest.opt("android"));
        state.put("requiresShell", manifest.getInt("minimumShellApi") > BuildConfig.SHELL_API);
    }
    String activate() throws Exception { synchronized (LOCK) {
        JSONObject state = pointers(); String next = state.optString("pending");
        if (!next.isEmpty()) { state.put("active", next); state.remove("pending"); publish(state); }
        return state.optString("active");
    } }
    // Call on process startup, before any WebView pins a release. Never collect
    // the files underneath a running foreground page or background worker.
    void collect() throws Exception { synchronized (LOCK) {
        JSONObject state = pointers();
        for (File file : Objects.requireNonNull(root.listFiles())) if (file.isDirectory() && !file.getName().equals(state.optString("active")) && !file.getName().equals(state.optString("pending"))) remove(file);
    } }
    static void write(File file, byte[] bytes) throws Exception { try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); out.getFD().sync(); } }
    static void remove(File file) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory()) for (File child : Objects.requireNonNull(file.listFiles())) remove(child);
        if (!file.delete()) throw new IOException("Could not remove " + file.getName());
    }
}
