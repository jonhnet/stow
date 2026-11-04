package net.stowapp.android;

import android.content.*;
import android.net.Uri;
import android.webkit.*;
import androidx.webkit.*;
import org.json.JSONObject;
import java.io.*;
import java.util.*;

/** One installed release is pinned for this page's entire lifetime. */
final class WebHost {
    interface Listener {
        void message(JSONObject message); void failure(String reason);
        default boolean chooseFiles(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) { return false; }
    }
    final WebView view;
    private boolean destroyed;
    private final String origin;
    WebHost(Context context, String release, boolean background, String trigger, Listener listener) throws Exception {
        DeviceState state = new DeviceState(context); origin = state.origin();
        state.cookies();
        File directory = new ReleaseStore(context).directory(release);
        JSONObject manifest = new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(directory, "release.json").toPath()), java.nio.charset.StandardCharsets.UTF_8));
        JSONObject files = manifest.getJSONObject("files");
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) throw new IllegalStateException("Update Android System WebView to use Stow.");
        view = new WebView(context);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        view.getSettings().setJavaScriptEnabled(true); view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setAllowFileAccess(false); view.getSettings().setAllowContentAccess(false);
        view.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        view.getSettings().setUserAgentString(view.getSettings().getUserAgentString() + " StowAndroid/" + BuildConfig.VERSION_CODE);
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        WebViewCompat.addWebMessageListener(view, "StowShell", Set.of(origin), (webView, message, sourceOrigin, isMainFrame, reply) -> {
            if (!isMainFrame || !origin.equals(sourceOrigin.toString())) return;
            try { String data = message.getData(); if (data == null || data.length() > 65536) throw new IllegalArgumentException("Invalid shell message"); listener.message(new JSONObject(data)); }
            catch (Exception e) { listener.failure("Shell message failed: " + e.getMessage()); }
        });
        JSONObject config = new JSONObject().put("api", BuildConfig.SHELL_API).put("version", BuildConfig.VERSION_CODE).put("release", release).put("account", new JSONObject(state.account()));
        if (background) config.put("trigger", trigger).put("nativeEvents", state.events());
        WebViewCompat.addDocumentStartJavaScript(view, "Object.defineProperty(window,'__STOW_SHELL__',{value:Object.freeze(" + config + "),writable:false});", Set.of(origin));
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView web, ValueCallback<Uri[]> callback, FileChooserParams params) { return listener.chooseFiles(callback, params); }
            @Override public boolean onConsoleMessage(ConsoleMessage message) { android.util.Log.i("StowWeb", message.message() + " @" + message.sourceId() + ":" + message.lineNumber()); return true; }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!origin.equals(uri.getScheme() + "://" + uri.getEncodedAuthority())) return denied();
                String name = uri.getPath();
                if (name != null && name.startsWith("/native/api/")) return null;
                if ("/".equals(name)) name = "/index.html";
                if (name == null || !files.has(name) || !"GET".equals(request.getMethod())) return denied();
                try {
                    String mime = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png" : "application/octet-stream";
                    return new WebResourceResponse(mime, "UTF-8", 200, "OK", Map.of("Cache-Control", "no-store", "X-Content-Type-Options", "nosniff", "Content-Security-Policy", "frame-src 'none'; object-src 'none'; base-uri 'none'"), new FileInputStream(new File(directory, name.substring(1))));
                } catch (IOException e) { return denied(); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                Uri uri = request.getUrl();
                if (uri.toString().equals(origin + "/") || uri.toString().startsWith(origin + "/index.html")) return false;
                if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
                    Intent external = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(external);
                }
                return true;
            }
            @Override public void onReceivedError(WebView web, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) listener.failure(error.getDescription().toString()); }
            @Override public boolean onRenderProcessGone(WebView web, RenderProcessGoneDetail detail) { destroy(); listener.failure("The web renderer stopped. Saved notes are retained."); return true; }
            @Override public void onPageFinished(WebView web, String url) { if (!background) sendStatus(context); }
        });
        view.loadUrl(origin + (background ? "/background.html" : "/index.html"));
    }
    private static WebResourceResponse denied() { return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", Map.of(), new ByteArrayInputStream(new byte[0])); }
    void event(JSONObject message) { view.evaluateJavascript("window.dispatchEvent(new CustomEvent('stow-shell',{detail:" + message + "}))", null); }
    void sendStatus(Context context) { try { event(new ReleaseStore(context).status()); } catch (Exception e) { new DeviceState(context).event("release status: " + e.getMessage()); } }
    void destroy() {
        if (destroyed) return;
        destroyed = true;
        if (view.getParent() instanceof android.view.ViewGroup parent) parent.removeView(view);
        view.stopLoading(); view.destroy();
    }
}
