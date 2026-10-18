#!/usr/bin/env python3
"""Test services in the Dienste hub — runs in the claraos-api container:

    docker exec -i claraos-claraos-api-1 python3 - an <id> <name> <url> [<required_group>] < dienst_test_hilfe.py
    docker exec -i claraos-claraos-api-1 python3 - weg <id> < dienst_test_hilfe.py

Writes the same row shape the hub creates (routers/hub.py _build_manifest), marked
created_by='test'. Only ids starting with "testdienst-" are touched.
"""
import asyncio
import json
import sys

from database import get_pool


async def main() -> None:
    aktion, app_id = sys.argv[1], sys.argv[2]
    assert app_id.startswith("testdienst-")
    pool = await get_pool()
    async with pool.acquire() as conn:
        if aktion == "an":
            name, url = sys.argv[3], sys.argv[4]
            gruppen = sys.argv[5:6]
            manifest = {"id": app_id, "name": name, "icon": "🌐", "type": "selkies",
                        "category": "services", "source": "third-party", "activated": True,
                        "hubService": True, "config": {"url": url}, "requiredGroups": gruppen,
                        "permissions": []}
            await conn.execute(
                """INSERT INTO claraos_apps (id, manifest, enabled, created_by) VALUES ($1, $2::jsonb, TRUE, 'test')
                   ON CONFLICT (id) DO UPDATE SET manifest = EXCLUDED.manifest""",
                app_id, json.dumps(manifest))
        else:
            await conn.execute("DELETE FROM claraos_apps WHERE id = $1 AND created_by = 'test'", app_id)
    print("OK", aktion, app_id)


asyncio.run(main())
