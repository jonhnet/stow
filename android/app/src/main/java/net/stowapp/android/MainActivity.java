package net.stowapp.android;

import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.File;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebHost host;
    private boolean visible;
    private TextView message;
    private String pairingOrigin, requestId, verifier, pairingCode;
    private boolean polling;
    private File pendingApk, exportFile;
    private NativeExport export;
    private boolean downloadingApk, exporting;
    private android.webkit.ValueCallback<Uri[]> fileSelection;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        export = new NativeExport(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (state != null) {
            pairingOrigin = state.getString("pairingOrigin"); requestId = state.getString("requestId");
            verifier = state.getString("verifier"); pairingCode = state.getString("pairingCode");
        }
        DeviceState device = new DeviceState(this);
        try {
            if (requestId != null) setup();
            else if (device.paired() && !new ReleaseStore(this).active().isEmpty()) { showWeb(); checkRelease(); }
            else if (device.paired()) { setup(); initialRelease(); }
            else setup();
        } catch (Exception e) { setup(); error(e); }
    }
    private void setup() {
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 80, 32, 32);
        TextView title = new TextView(this); title.setText("Connect Stow"); title.setTextSize(24); layout.addView(title);
        EditText server = new EditText(this); server.setText(pairingOrigin != null ? pairingOrigin : new DeviceState(this).origin()); server.setHint("https://your-stow-server"); server.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); layout.addView(server);
        EditText name = new EditText(this); name.setHint("Device name"); name.setText(Build.MODEL); layout.addView(name);
        Button connect = new Button(this); connect.setText(requestId == null ? "Sign in with browser" : "Open sign-in page"); layout.addView(connect);
        message = new TextView(this); message.setTextIsSelectable(true); layout.addView(message);
        if (pairingCode != null) showPairingCode();
        connect.setOnClickListener(v -> {
            try {
                if (requestId != null) {
                    ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Stow pairing code", pairingCode));
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(pairingOrigin + "/device.html?request=" + requestId)));
                    return;
                }
                pairingOrigin = DeviceState.validOrigin(server.getText().toString()); verifier = Http.random(); connect.setEnabled(false);
                JSONObject body = new JSONObject().put("name", name.getText().toString()).put("challenge", Http.hash(verifier.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                io.execute(() -> {
                    try {
                        Http.Reply response = Http.request(pairingOrigin + "/native/device/start", body, null, 4096);
                        if (response.status() != 201) throw new Exception("Pairing failed (HTTP " + response.status() + ")");
                        JSONObject value = response.json();
                        ui(() -> { requestId = value.optString("requestId"); pairingCode = value.optString("code"); showPairingCode(); connect.setEnabled(true); connect.setText("Open sign-in page"); });
                    } catch (Exception e) { ui(() -> { connect.setEnabled(true); error(e); }); }
                });
            } catch (Exception e) { error(e); }
        });
        if (new DeviceState(this).paired()) {
            Button retry = new Button(this); retry.setText("Open saved Stow"); layout.addView(retry);
            retry.setOnClickListener(v -> { try { if (new ReleaseStore(this).active().isEmpty()) initialRelease(); else showWeb(); } catch (Exception e) { error(e); } });
            try {
                JSONObject apk = new ReleaseStore(this).status().optJSONObject("android");
                if (apk != null && apk.getInt("version") > BuildConfig.VERSION_CODE) {
                    Button update = new Button(this); update.setText("Update Android app"); layout.addView(update);
                    update.setOnClickListener(v -> updateApk());
                }
            } catch (Exception e) { error(e); }
        }
        setScreen(layout);
    }
    private void showPairingCode() { message.setText("Pairing code: " + pairingCode + "\nOpen the sign-in page, paste this code, then return here. Opening the page copies the code."); }
    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("pairingOrigin", pairingOrigin); state.putString("requestId", requestId);
        state.putString("verifier", verifier); state.putString("pairingCode", pairingCode);
    }
    private void pollPairing() {
        if (!visible || requestId == null || polling) return;
        polling = true;
        io.execute(() -> {
            try {
                Http.Reply response = Http.request(pairingOrigin + "/native/device/token", new JSONObject().put("requestId", requestId).put("verifier", verifier), null, 8192);
                if (response.status() == 200) {
                    JSONObject grant = response.json();
                    ui(() -> {
                        try { new DeviceState(this).pair(pairingOrigin, grant); requestId = null; Scheduler.register(this); initialRelease(); }
                        catch (Exception e) { error(e); }
                    });
                } else if (response.status() != 202) { requestId = null; throw new Exception("Pairing expired or was rejected. Start sign-in again."); }
            } catch (Exception e) { ui(() -> error(e)); }
            finally { ui(() -> { polling = false; if (requestId != null && visible) main.postDelayed(this::pollPairing, 2500); }); }
        });
    }
    private void initialRelease() {
        if (message != null) message.setText("Downloading Stow…");
        io.execute(() -> { try { new ReleaseStore(this).check(new DeviceState(this).origin()); ui(() -> {
            try {
                if (new ReleaseStore(this).active().isEmpty()) { setup(); message.setText("Update the Android app to open this Stow release."); }
                else showWeb();
            } catch (Exception e) { error(e); }
        }); } catch (Exception e) { ui(() -> error(e)); } });
    }
    private void checkRelease() {
        io.execute(() -> { try { new ReleaseStore(this).check(new DeviceState(this).origin()); ui(() -> { if (host != null) host.sendStatus(this); }); } catch (Exception e) { new DeviceState(this).event("foreground update check failed: " + e.getMessage()); } });
    }
    private void showWeb() throws Exception {
        WebHost previous = host;
        host = new WebHost(this, new ReleaseStore(this).active(), false, null, new WebHost.Listener() {
            public void message(JSONObject value) {
                switch (value.optString("type")) {
                    case "ready" -> host.sendStatus(MainActivity.this);
                    case "sign-in" -> { host.destroy(); host = null; setup(); }
                    case "activate" -> {
                        if (value.optBoolean("automatic") && visible) return;
                        try { new ReleaseStore(MainActivity.this).activate(); showWeb(); }
                        catch (Exception e) { error(e); }
                    }
                    case "update-apk" -> updateApk();
                    case "manage-devices" -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(new DeviceState(MainActivity.this).origin() + "/device.html")));
                    case "export-start", "export-chunk", "export-end" -> {
                        if ("export-start".equals(value.optString("type")) && exporting) { error(new Exception("Finish the current export first")); return; }
                        try {
                            switch (value.getString("type")) {
                                case "export-start" -> { export.start(value); exporting = true; }
                                case "export-chunk" -> export.chunk(value);
                                case "export-end" -> {
                                    exportFile = export.finish();
                                    startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(export.mime).putExtra(Intent.EXTRA_TITLE, export.filename), 26);
                                }
                            }
                        } catch (Exception e) { export.cancel(); exporting = false; error(e); }
                    }
                    case "check-updates" -> checkRelease();
                }
            }
            public void failure(String reason) {
                if (isFinishing() || isDestroyed()) return;
                new android.app.AlertDialog.Builder(MainActivity.this).setMessage(reason).setPositiveButton("Reopen Stow", (dialog, which) -> {
                    try { showWeb(); } catch (Exception e) { error(e); }
                }).show();
            }
            public boolean chooseFiles(android.webkit.ValueCallback<Uri[]> callback, android.webkit.WebChromeClient.FileChooserParams params) {
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                startActivityForResult(params.createIntent(), 25); return true;
            }
        });
        setScreen(host.view);
        if (previous != null) previous.destroy();
    }
    private void setScreen(View child) {
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(android.graphics.Color.WHITE);
        frame.addView(child, new FrameLayout.LayoutParams(-1, -1));
        // Insets belong on a native parent. Padding WebView itself does not move
        // CSS fixed-position headers away from the system status/navigation bars.
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(frame, (view, insets) -> {
            var edges = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() | androidx.core.view.WindowInsetsCompat.Type.ime());
            view.setPadding(edges.left, edges.top, edges.right, edges.bottom);
            return insets;
        });
        setContentView(frame);
        var bars = androidx.core.view.WindowCompat.getInsetsController(getWindow(), frame);
        bars.setAppearanceLightStatusBars(true); bars.setAppearanceLightNavigationBars(true);
        androidx.core.view.ViewCompat.requestApplyInsets(frame);
    }
    private void ui(Runnable action) { main.post(() -> { if (!isDestroyed()) action.run(); }); }
    private void error(Exception error) { if (message != null && host == null) message.setText(error.getMessage()); else Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); }
    @Override protected void onResume() { super.onResume(); visible = true; pollPairing(); if (host != null) { host.view.onResume(); host.sendStatus(this); try { host.event(new JSONObject().put("type", "visible")); } catch (Exception e) { error(e); } } }
    @Override protected void onPause() { visible = false; if (host != null) try { host.event(new JSONObject().put("type", "hidden")); } catch (Exception e) { error(e); } super.onPause(); }
    @Override protected void onDestroy() { if (host != null) { host.destroy(); host = null; } io.shutdownNow(); main.removeCallbacksAndMessages(null); super.onDestroy(); }
    @Override public void onBackPressed() { if (host != null && host.view.canGoBack()) host.view.goBack(); else super.onBackPressed(); }
    private void updateApk() {
        if (downloadingApk) return;
        downloadingApk = true;
        Toast.makeText(this, "Downloading Android update…", Toast.LENGTH_SHORT).show();
        io.execute(() -> { try {
            DeviceState state = new DeviceState(this); JSONObject apk = new ReleaseStore(this).status().getJSONObject("android");
            if (apk.getInt("version") <= BuildConfig.VERSION_CODE || apk.getInt("minSdk") > Build.VERSION.SDK_INT) throw new Exception("No compatible Android update is available");
            Http.Reply response = Http.request(state.origin() + apk.getString("url"), null, null, 64 * 1024 * 1024);
            if (response.status() != 200 || !Http.hash(response.bytes()).equals(apk.getString("sha256"))) throw new Exception("Android update failed verification");
            File directory = new File(getFilesDir(), "apk-updates"); directory.mkdirs();
            File file = new File(directory, "stow.apk"); ReleaseStore.write(file, response.bytes());
            ApkVerifier.verify(getPackageManager(), getPackageName(), file, apk.getLong("version"));
            ui(() -> { pendingApk = file; installApk(); });
        } catch (Exception e) { ui(() -> error(e)); }
        finally { ui(() -> downloadingApk = false); } });
    }
    private void installApk() {
        if (!getPackageManager().canRequestPackageInstalls()) { startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())), 24); return; }
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".updates", pendingApk);
        startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); pendingApk = null;
    }
    @Override protected void onActivityResult(int request, int result, Intent data) { super.onActivityResult(request, result, data); if (request == 25 && fileSelection != null) { fileSelection.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(result, data)); fileSelection = null; }
        if (request == 26 && exportFile != null) {
            File file = exportFile; exportFile = null;
            if (result != RESULT_OK || data == null || data.getData() == null) { file.delete(); exporting = false; return; }
            Uri destination = data.getData();
            io.execute(() -> {
                try (java.io.InputStream input = new java.io.FileInputStream(file); java.io.OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new java.io.IOException("Could not open the selected file");
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                } catch (Exception e) { ui(() -> error(e)); } finally { file.delete(); ui(() -> exporting = false); }
            });
        }
        if (request == 24 && pendingApk != null && getPackageManager().canRequestPackageInstalls()) installApk(); }
}
