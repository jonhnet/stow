package net.stowapp.android;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class ReleaseStoreTest {
    Context context; ReleaseStore store; Fixture server;
    @Before public void before() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        ReleaseStore.remove(new File(context.getFilesDir(), "web-releases")); store = new ReleaseStore(context); server = new Fixture();
    }
    @After public void after() throws Exception { server.close(); }
    @Test public void freshInstallKeepsShellUpdateMetadataWhenWebReleaseRequiresNewerShell() throws Exception {
        server.minimumApi = 99;
        store.check(server.origin());
        assertEquals("", store.active());
        assertTrue(store.status().getBoolean("requiresShell"));
        assertEquals(2, store.status().getJSONObject("android").getInt("version"));
    }
    @Test public void interruptedCorruptAndIncompatibleUpdatesRetainInstalledRelease() throws Exception {
        store.check(server.origin()); String first = store.active(); assertFalse(first.isEmpty());
        server.version = 2; server.corrupt = true;
        assertThrows(Exception.class, () -> store.check(server.origin()));
        assertEquals(first, new ReleaseStore(context).active()); assertEquals("", store.status().getString("pending"));
        server.corrupt = false; server.status = 302;
        assertThrows(Exception.class, () -> store.check(server.origin())); assertEquals(first, store.active());
        server.status = 404; assertThrows(Exception.class, () -> store.check(server.origin()));
        server.status = 200; server.minimumApi = 99; store.check(server.origin());
        assertTrue(store.status().getBoolean("requiresShell")); assertEquals(first, store.active());
        server.minimumApi = 1; store.check(server.origin()); String next = store.status().getString("pending"); assertFalse(next.isEmpty());
        assertEquals(first, new ReleaseStore(context).active());
        server.close(); assertEquals(next, store.activate()); assertEquals(next, new ReleaseStore(context).active());
        assertTrue(new File(store.directory(first), "index.html").isFile()); // pinned old page still works
        store.collect(); assertFalse(store.directory(first).exists()); assertTrue(store.directory(next).exists());
    }
    @Test public void stalledDownloadNeverBlocksLaunchAndCannotUndoConcurrentActivation() throws Exception {
        store.check(server.origin()); server.version = 2; store.check(server.origin());
        String second = store.status().getString("pending");
        server.version = 3; server.hold = true;
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<?> download = pool.submit(() -> { try { store.check(server.origin()); } catch (Exception e) { throw new RuntimeException(e); } });
            assertTrue(server.assetRequested.await(5, TimeUnit.SECONDS));
            Future<String> launch = pool.submit(() -> { store.active(); store.status(); return store.activate(); });
            assertEquals(second, launch.get(1, TimeUnit.SECONDS));
            server.release.countDown(); download.get(10, TimeUnit.SECONDS);
            assertEquals(second, store.active()); assertNotEquals(second, store.status().getString("pending"));
        } finally { server.release.countDown(); pool.shutdownNow(); }
    }
    static final class Fixture implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        final ExecutorService pool = Executors.newCachedThreadPool();
        final CountDownLatch assetRequested = new CountDownLatch(1), release = new CountDownLatch(1);
        volatile int version = 1, status = 200, minimumApi = 1; volatile boolean corrupt, hold;
        Fixture() throws Exception { pool.execute(() -> { while (!socket.isClosed()) try { Socket client = socket.accept(); pool.execute(() -> serve(client)); } catch (IOException ignored) {} }); }
        String origin() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        void serve(Socket client) {
            try (client) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream())); String path = reader.readLine().split(" ")[1];
                while (!reader.readLine().isEmpty()) {}
                byte[] asset = ("release " + version).getBytes(StandardCharsets.UTF_8);
                byte[] body;
                if (path.endsWith("release.json")) {
                    JSONObject file = new JSONObject().put("bytes", asset.length).put("sha256", Http.hash(asset));
                    body = new JSONObject().put("format", 1).put("release", Http.hash(asset)).put("minimumShellApi", minimumApi)
                        .put("android", new JSONObject().put("version", 2).put("minSdk", 28).put("url", "/native/android/stow-2.apk").put("sha256", Http.hash(asset)))
                        .put("files", new JSONObject().put("/index.html", file).put("/background.html", file)).toString().getBytes(StandardCharsets.UTF_8);
                } else { if (hold) { assetRequested.countDown(); release.await(10, TimeUnit.SECONDS); } body = corrupt ? "bad".getBytes() : asset; }
                OutputStream out = client.getOutputStream(); out.write(("HTTP/1.1 " + status + " Test\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes()); out.write(body);
            } catch (Exception ignored) {}
        }
        public void close() throws Exception { release.countDown(); socket.close(); pool.shutdownNow(); }
    }
}
