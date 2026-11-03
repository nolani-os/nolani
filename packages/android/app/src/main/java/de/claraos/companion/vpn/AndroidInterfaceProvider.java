package de.claraos.companion.vpn;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

import claratsnet.InterfaceProvider;

/**
 * Returns the network interfaces via Android {@link NetworkInterface} as JSON —
 * bypasses Go's netlink-based {@code net.Interfaces()}, which Android sandboxes from 11 on
 * ({@code netlinkrib: permission denied}). Without this tsnet.Up fails.
 *
 * JSON format = that of tailscale-android App.kt (expected by ifaceparse.ParseInterfacesJSONAsNetmon):
 * [{"name","index","mtu","up","broadcast","loopback","pointToPoint","multicast",
 *   "addrs":[{"ip","prefixLen"}]}]
 */
public final class AndroidInterfaceProvider implements InterfaceProvider {

    @Override
    public String getInterfacesAsJson() throws Exception {
        List<NetworkInterface> ifaces =
                Collections.list(NetworkInterface.getNetworkInterfaces());
        JSONArray out = new JSONArray();
        for (NetworkInterface nif : ifaces) {
            try {
                JSONArray addrs = new JSONArray();
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    if (ia.getAddress() == null) continue;
                    String host = ia.getAddress().getHostAddress();
                    if (host == null) continue;
                    // Strip the IPv6 zone suffix (fe80::...%wlan0) — ifaceparse wants a bare IP.
                    int pct = host.indexOf('%');
                    if (pct >= 0) host = host.substring(0, pct);
                    addrs.put(new JSONObject()
                            .put("ip", host)
                            .put("prefixLen", ia.getNetworkPrefixLength()));
                }
                boolean multicast = nif.supportsMulticast();
                out.put(new JSONObject()
                        .put("name", nif.getName())
                        .put("index", nif.getIndex())
                        .put("mtu", nif.getMTU())
                        .put("up", nif.isUp())
                        .put("broadcast", multicast)
                        .put("loopback", nif.isLoopback())
                        .put("pointToPoint", nif.isPointToPoint())
                        .put("multicast", multicast)
                        .put("addrs", addrs));
            } catch (Exception e) {
                // skip this interface (isUp/isLoopback may throw)
            }
        }
        return out.toString();
    }
}
