package de.claraos.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Address checks of the connect screen. Runs per flavor: generic vs. home build. */
public class ProvisioningClientTest {

    private static boolean generic() {
        return ProvisioningClient.DIRECT_DOMAIN.isEmpty();
    }

    @Test
    public void directServerAddsHomePrefixAndKeepsHttps() {
        String domain = generic() ? "example.org" : ProvisioningClient.DIRECT_DOMAIN;
        assertEquals("https://home." + domain + "/", ProvisioningClient.normalizeDirectServer(domain));
        assertEquals("https://home." + domain + "/",
                ProvisioningClient.normalizeDirectServer("https://home." + domain + "/some/path"));
    }

    @Test
    public void directServerRejectsUnsafeInput() {
        assertNull(ProvisioningClient.normalizeDirectServer("http://example.org"));
        assertNull(ProvisioningClient.normalizeDirectServer("user@example.org"));
        assertNull(ProvisioningClient.normalizeDirectServer("example.org:8443"));
        assertNull(ProvisioningClient.normalizeDirectServer("10.0.0.5"));
        assertNull(ProvisioningClient.normalizeDirectServer("localhost"));
        assertNull(ProvisioningClient.normalizeDirectServer(""));
        assertNull(ProvisioningClient.normalizeDirectServer(null));
    }

    @Test
    public void directServerOutsideFixedDomainOnlyInGenericBuild() {
        String url = ProvisioningClient.normalizeDirectServer("cell.example.net");
        if (generic()) {
            assertEquals("https://home.cell.example.net/", url);
        } else {
            assertNull(url);
        }
    }

    @Test
    public void controlUrl() {
        assertEquals(ProvisioningClient.DEFAULT_CONTROL_URL, ProvisioningClient.normalizeControlUrl(""));
        assertEquals("https://hs.example.org", ProvisioningClient.normalizeControlUrl("hs.example.org/"));
        assertEquals("https://hs.example.org:8443", ProvisioningClient.normalizeControlUrl("https://hs.example.org:8443"));
        assertNull(ProvisioningClient.normalizeControlUrl("http://hs.example.org"));
        assertNull(ProvisioningClient.normalizeControlUrl("https://user@hs.example.org"));
        assertNull(ProvisioningClient.normalizeControlUrl("https://10.0.0.5"));
    }

    @Test
    public void hostNames() {
        assertTrue(ProvisioningClient.isHostName("a.example.org"));
        assertTrue(ProvisioningClient.isHostName("1-2-3-4.sslip.io"));
        assertFalse(ProvisioningClient.isHostName("example"));
        assertFalse(ProvisioningClient.isHostName("a..org"));
        assertFalse(ProvisioningClient.isHostName("-a.org"));
        assertFalse(ProvisioningClient.isHostName("1.2.3.4"));
    }

    @Test
    public void origins() {
        assertEquals("https://home.example.org", ProvisioningClient.originOf("https://home.example.org/"));
        assertEquals("https://home.example.org", ProvisioningClient.originOf("https://Home.Example.org:443/x?y=1"));
        assertEquals("https://home.example.org:8443", ProvisioningClient.originOf("https://home.example.org:8443/"));
        assertEquals("http://shell.internal", ProvisioningClient.originOf("http://shell.internal:80/"));
        assertNull(ProvisioningClient.originOf(null));
        assertNull(ProvisioningClient.originOf("javascript:alert(1)"));
        assertNull(ProvisioningClient.originOf("file:///sdcard/x.html"));
        assertNull(ProvisioningClient.originOf("not a url"));
    }
}
