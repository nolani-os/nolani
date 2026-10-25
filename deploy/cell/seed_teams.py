#!/usr/bin/env python3
"""Demo team for the showcase shot of the Teams app. Runs INSIDE the claraos-api container:

    docker compose exec -T claraos-api python3 - <user> < seed_teams.py

A team is an m.space, its channels are rooms linked by m.space.child (matrixClient.ts).
The conversation needs more than one person, so two Matrix-only demo users (no Authentik
account, no password) join: they can only be used through an admin login, which this
script limits to 15 minutes and logs out again at the end.

The test account outlives a run: rooms of an earlier run are left and forgotten first,
otherwise the team shows twice. Demo data for the README showcase, not used by the cell itself.
"""
import asyncio
import sys
import time
import urllib.parse

sys.path.insert(0, "/app")
import httpx  # noqa: E402
from routers.teams_admin import SYNAPSE_URL, _get_synapse_admin_token, _mxid  # noqa: E402

USER = sys.argv[1]
TEAM = "Website relaunch"
KANAELE = ["General", "Design", "Content"]
GAESTE = {"sarah.demo": "Sarah Chen", "tom.demo": "Tom Becker"}
# (channel, speaker, text) in order; "me" = the test account (Alex Morgan in the shots).
GESPRAECH = [
    ("General", "me", "Morning all 👋 Kick-off for the website relaunch is Monday at 9:30 — the call link is in the calendar."),
    ("General", "sarah.demo", "Great! The first homepage mock-ups are in Files → Projects / Website relaunch / Design."),
    ("General", "tom.demo", "Had a look — the hero image feels a bit dark, and pricing is hard to find."),
    ("General", "sarah.demo", "Fair point. I'll try a lighter blue for the hero before the design review."),
    ("General", "me", "Design review moved to Tuesday, 2 pm. Nolani already put the next steps into the project brief 🙌"),
    ("General", "tom.demo", "Perfect, then I'll start on the About page."),
    ("Design", "sarah.demo", "Colour palette v2: a lighter blue for the hero, the accent stays as it is."),
    ("Content", "tom.demo", "Blog migration: 42 posts, old links need redirects — the list is in the brief."),
]


def q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


async def main() -> None:
    admin = await _get_synapse_admin_token()
    ah = {"Authorization": f"Bearer {admin}"}
    async with httpx.AsyncClient(timeout=30) as c:

        async def mx(method: str, path: str, token: str, body: dict | None = None) -> dict:
            for _ in range(10):
                r = await c.request(method, SYNAPSE_URL + path, json=body,
                                    headers={"Authorization": f"Bearer {token}"})
                if r.status_code == 429:  # rate limit — wait as long as the server asks
                    await asyncio.sleep(r.json().get("retry_after_ms", 1000) / 1000 + 0.2)
                    continue
                r.raise_for_status()
                return r.json() if r.content else {}
            raise RuntimeError(f"still rate-limited: {path}")

        ich = await _mxid(USER)
        domain = ich.split(":", 1)[1]
        ids = {"me": ich, **{lp: f"@{lp}:{domain}" for lp in GAESTE}}
        for lp, name in GAESTE.items():
            r = await c.put(f"{SYNAPSE_URL}/_synapse/admin/v2/users/{q(ids[lp])}", headers=ah,
                            json={"displayname": name})
            r.raise_for_status()
        tokens = {}
        bis = int(time.time() * 1000) + 15 * 60 * 1000
        for wer, mxid in ids.items():
            await c.post(f"{SYNAPSE_URL}/_synapse/admin/v1/users/{q(mxid)}/override_ratelimit",
                         headers=ah, json={"messages_per_second": 0, "burst_count": 0})
            r = await c.post(f"{SYNAPSE_URL}/_synapse/admin/v1/users/{q(mxid)}/login",
                             headers=ah, json={"valid_until_ms": bis})
            r.raise_for_status()
            tokens[wer] = r.json()["access_token"]
        await mx("PUT", f"/_matrix/client/v3/profile/{q(ich)}/displayname", tokens["me"],
                 {"displayname": "Alex Morgan"})

        weg = 0
        for wer, t in tokens.items():
            for raum in (await mx("GET", "/_matrix/client/v3/joined_rooms", t)).get("joined_rooms", []):
                try:
                    name = (await mx("GET", f"/_matrix/client/v3/rooms/{q(raum)}/state/m.room.name/", t)).get("name")
                except httpx.HTTPStatusError:
                    continue
                if name in [TEAM, *KANAELE]:
                    await mx("POST", f"/_matrix/client/v3/rooms/{q(raum)}/leave", t, {})
                    await mx("POST", f"/_matrix/client/v3/rooms/{q(raum)}/forget", t, {})
                    weg += 1
        print("TEAMS alte Räume entfernt", weg)

        gaeste = [ids[lp] for lp in GAESTE]
        space = (await mx("POST", "/_matrix/client/v3/createRoom", tokens["me"], {
            "name": TEAM, "visibility": "private", "creation_content": {"type": "m.space"},
            "invite": gaeste, "power_level_content_override": {"events_default": 0}}))["room_id"]
        raeume = {}
        for kanal in KANAELE:
            raum = (await mx("POST", "/_matrix/client/v3/createRoom", tokens["me"], {
                "name": kanal, "visibility": "private", "preset": "private_chat",
                "invite": gaeste}))["room_id"]
            await mx("PUT", f"/_matrix/client/v3/rooms/{q(space)}/state/m.space.child/{q(raum)}",
                     tokens["me"], {"via": [domain]})
            raeume[kanal] = raum
        for lp in GAESTE:
            for raum in [space, *raeume.values()]:
                await mx("POST", f"/_matrix/client/v3/join/{q(raum)}", tokens[lp], {})
        for i, (kanal, wer, text) in enumerate(GESPRAECH):
            await mx("PUT", f"/_matrix/client/v3/rooms/{q(raeume[kanal])}/send/m.room.message/"
                            f"s{int(time.time() * 1000)}{i}", tokens[wer],
                     {"msgtype": "m.text", "body": text})
            await asyncio.sleep(1.2)  # distinct timestamps, the app groups by sender and minute
        print("TEAMS", TEAM, "mit", len(KANAELE), "Kanälen,", len(GESPRAECH), "Nachrichten")
        for t in tokens.values():
            await mx("POST", "/_matrix/client/v3/logout", t, {})


asyncio.run(main())
