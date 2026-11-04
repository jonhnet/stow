package net.stowapp.android;
import org.junit.Test;
import static org.junit.Assert.*;
public class OriginTest {
    @Test public void originMatchesTheBrowserCanonicalOrigin() {
        assertEquals("https://stow.example", DeviceState.validOrigin("HTTPS://STOW.EXAMPLE:443/"));
        assertEquals("http://localhost", DeviceState.validOrigin("http://LOCALHOST:80/"));
        assertEquals("http://localhost:4276", DeviceState.validOrigin("http://localhost:4276"));
        for (String value : new String[]{"http://stow.example", "https://user:password@stow.example", "https://stow.example/path", "https://stow.example/?query", "file:///tmp/page", "javascript:alert(1)"}) {
            assertThrows(value, IllegalArgumentException.class, () -> DeviceState.validOrigin(value));
        }
    }
}
