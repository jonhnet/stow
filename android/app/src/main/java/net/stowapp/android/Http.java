package net.stowapp.android;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;

final class Http {
    record Reply(int status, byte[] bytes) { JSONObject json() throws Exception { return new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)); } }
    static Reply request(String url, JSONObject body, String token, int limit) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(false); c.setConnectTimeout(10000); c.setReadTimeout(15000);
        c.setRequestProperty("Cache-Control", "no-cache");
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "StowDevice " + token);
        try {
            if (body != null) {
                c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) { out.write(body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            }
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) throw new IOException("Unexpected redirect. Check the server's /native/ proxy configuration.");
            try (InputStream input = code >= 400 ? c.getErrorStream() : c.getInputStream()) {
                return new Reply(code, input == null ? new byte[0] : read(input, limit));
            }
        } finally { c.disconnect(); }
    }
    static byte[] read(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = in.read(buffer)) != -1) { if (out.size() + count > max) throw new IOException("Download exceeds its size limit"); out.write(buffer, 0, count); }
        return out.toByteArray();
    }
    static String hash(byte[] bytes) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(); for (byte b : bytes) result.append(String.format("%02x", b & 255)); return result.toString(); }
    static String random() { byte[] bytes = new byte[32]; new java.security.SecureRandom().nextBytes(bytes); return hex(bytes); }
}
