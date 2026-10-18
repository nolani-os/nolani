"""Restore test for the cell via the Hetzner API — set up (create) or tear down (destroy).

    python3 restore_test.py create    → snapshot, firewall, test server; prints the IP
    python3 restore_test.py destroy   → delete test server, firewall, snapshot
Token from HCLOUD_TOKEN_FILE (never printed). Every resource carries the test label in L.
"""
import json
import sys
import time
import urllib.error
import urllib.request

import os
# Token from a file (keep it in RAM only, e.g. /dev/shm/…) — never as an argument or in a log.
T = open(os.environ.get("HCLOUD_TOKEN_FILE", "/dev/shm/hcloud-token")).read().strip()
# Cell server to copy (its Hetzner name) and the project label of the test resources
SERVER = os.environ.get("ZELLE_SERVER", "claraos-cell")
L = {"projekt": SERVER, "test": "restore-test"}
# Admin network allowed to SSH into the test server (e.g. your own WAN IP as a.b.c.d/32)
WAN = os.environ["ZELLE_ADMIN_CIDR"]
# Name of the SSH key in the Hetzner project (same as ssh_key_name in the tfvars)
SSH_KEY = os.environ.get("ZELLE_SSH_KEY", "claraos-admin")


def api(m, p, b=None):
    r = urllib.request.Request("https://api.hetzner.cloud/v1/" + p, method=m,
                               data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": "Bearer " + T, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            t = resp.read().decode()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {m} {p}: {e.read().decode()[:300]}")


def warte_aktion(aid, was):
    for _ in range(180):
        a = api("GET", f"actions/{aid}")["action"]
        if a["status"] == "success":
            return
        if a["status"] == "error":
            raise SystemExit(f"{was} fehlgeschlagen: {a.get('error')}")
        time.sleep(5)
    raise SystemExit(f"{was}: Zeitüberschreitung")


sel = "label_selector=test%3Drestore-test"
if sys.argv[1] == "create":
    src = [s for s in api("GET", f"servers?name={SERVER}")["servers"]][0]
    snap = api("POST", f"servers/{src['id']}/actions/create_image",
               {"type": "snapshot", "description": "restore test", "labels": L})
    print("Snapshot wird erstellt …", flush=True)
    warte_aktion(snap["action"]["id"], "Snapshot")
    img = snap["image"]["id"]
    fw = api("POST", "firewalls", {"name": "claraos-restore-fw", "labels": L, "rules": [
        {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": [WAN], "description": "SSH from admin addresses only"}]})
    s = api("POST", "servers", {"name": "claraos-restore-test", "server_type": "cx43", "location": "nbg1",
                                "image": img, "ssh_keys": [SSH_KEY], "labels": L,
                                "firewalls": [{"firewall": fw["firewall"]["id"]}],
                                "public_net": {"enable_ipv4": True, "enable_ipv6": False}})
    warte_aktion(s["action"]["id"], "Server")
    print("IP", s["server"]["public_net"]["ipv4"]["ip"])
elif sys.argv[1] == "destroy":
    for s in api("GET", "servers?" + sel)["servers"]:
        warte_aktion(api("DELETE", f"servers/{s['id']}")["action"]["id"], "Server löschen")
        print("Server gelöscht", s["name"])
    time.sleep(5)
    for f in api("GET", "firewalls?" + sel)["firewalls"]:
        api("DELETE", f"firewalls/{f['id']}")
        print("Firewall gelöscht", f["name"])
    for i in api("GET", "images?type=snapshot&" + sel)["images"]:
        api("DELETE", f"images/{i['id']}")
        print("Snapshot gelöscht", i["id"])
