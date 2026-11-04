package net.stowapp.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;

final class DeviceState {
    private static final Object EVENTS_LOCK = new Object();
    private final SharedPreferences prefs;
    DeviceState(Context context) { prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE); }
    String origin() { return prefs.getString("origin", ""); }
    String token() { return prefs.getString("token", ""); }
    String account() { return prefs.getString("account", ""); }
    boolean paired() { return !token().isEmpty() && !account().isEmpty(); }
    long lastSuccess() { return prefs.getLong("lastSuccess", 0); }
    void success(long at) { if (!prefs.edit().putLong("lastSuccess", at).commit()) throw new IllegalStateException("Could not save refresh status"); }
    static String validOrigin(String value) {
        URI uri = URI.create(value.trim());
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        boolean local = "localhost".equalsIgnoreCase(uri.getHost()) || "127.0.0.1".equals(uri.getHost());
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !(uri.getPath().isEmpty() || "/".equals(uri.getPath())) || !("https".equals(scheme) || local && "http".equals(scheme))) throw new IllegalArgumentException("Enter an HTTPS server address. HTTP localhost is supported for development.");
        try {
            int port = uri.getPort();
            if (port == (scheme.equals("https") ? 443 : 80)) port = -1;
            return new URI(scheme, null, uri.getHost().toLowerCase(java.util.Locale.ROOT), port, null, null, null).toString();
        } catch (java.net.URISyntaxException e) { throw new IllegalArgumentException("Invalid server address", e); }
    }
    static JSONObject verifiedGrantAccount(JSONObject grant) throws Exception {
        JSONObject account = grant.getJSONObject("account");
        String vault = account.getString("vaultId");
        if (!grant.getString("token").matches("[a-f0-9]{64}") || account.getString("user").trim().isEmpty() ||
            !vault.matches("[a-zA-Z0-9_-]{16,128}") || vault.startsWith("share_") || account.has("principalId") ||
            !(account.getString("authMode").equals("proxy") || account.getString("authMode").equals("password")))
            throw new IllegalArgumentException("The server did not return a valid private account credential");
        return account;
    }
    void pair(String origin, JSONObject grant) throws Exception {
        String incoming = verifiedGrantAccount(grant).toString();
        if (paired()) {
            JSONObject previous = new JSONObject(account()), next = new JSONObject(incoming);
            if (!origin().equals(origin) || !previous.getString("vaultId").equals(next.getString("vaultId")) ||
                !previous.getString("user").equals(next.getString("user")) || !previous.getString("authMode").equals(next.getString("authMode")))
                throw new IllegalStateException("This installation already belongs to another account. Saved notes were retained.");
        }
        if (!prefs.edit().putString("origin", validOrigin(origin)).putString("token", grant.getString("token")).putString("account", incoming).commit()) throw new IllegalStateException("Could not save the device credential");
        cookies();
    }
    void cookies() {
        if (!paired()) return;
        CookieManager manager = CookieManager.getInstance(); manager.setAcceptCookie(true);
        manager.setCookie(origin() + "/native/", "stow_device=" + token() + "; Path=/native/; HttpOnly; SameSite=Strict; Max-Age=315360000" + (origin().startsWith("https:") ? "; Secure" : "")); manager.flush();
    }
    void event(String message) { event("shell", message); }
    void event(String trigger, String message) { synchronized (EVENTS_LOCK) {
        try {
            JSONArray existing = new JSONArray(prefs.getString("events", "[]"));
            JSONArray next = new JSONArray();
            for (int i = Math.max(0, existing.length() - 99); i < existing.length(); i++) next.put(existing.get(i));
            long sequence = prefs.getLong("eventSequence", 0) + 1;
            next.put(new JSONObject().put("sequence", sequence).put("at", System.currentTimeMillis()).put("message", message)
                .put("trigger", trigger).put("shellVersion", BuildConfig.VERSION_CODE));
            if (!prefs.edit().putString("events", next.toString()).putLong("eventSequence", sequence).commit()) throw new IllegalStateException("Could not save native diagnostics");
            android.util.Log.i("StowRefresh", message);
        } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
    } }
    JSONArray events() throws Exception { return new JSONArray(prefs.getString("events", "[]")); }
}
