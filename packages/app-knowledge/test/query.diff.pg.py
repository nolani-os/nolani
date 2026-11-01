"""PostgreSQL side of the differential test for src/local/query.ts.

Driven by query.diff.mjs (see there for how to run it). Loads the dataset into
a throwaway PostgreSQL, compiles every case with the server's real compiler
(packages/api/services/kb_query.py) and runs the SQL through asyncpg, the
driver the server uses.

Every case runs twice:
  * "stock":    a plain asyncpg connection, exactly like the server.
  * "datetext": the same, but `date` parameters are sent as text. With stock
                asyncpg a `$n::date` parameter only accepts datetime.date, so
                every absolute date filter of the compiler fails there; this
                connection shows what the compiled SQL means.

Usage: python3 -I query.diff.pg.py <api_dir> <host> <dataset.json> <cases.json> <out.json>
"""
import asyncio
import json
import sys
import time

api_dir, host, dataset_path, cases_path, out_path = sys.argv[1:6]
sys.path.insert(0, api_dir)
from services import kb_query  # noqa: E402

import asyncpg  # noqa: E402


async def connect() -> asyncpg.Connection:
    deadline = time.monotonic() + 60
    while True:
        try:
            return await asyncpg.connect(host=host, port=5432, user="postgres", database="postgres")
        except (OSError, asyncpg.PostgresError):
            if time.monotonic() > deadline:
                raise
            await asyncio.sleep(0.5)


async def run_case(conn: asyncpg.Connection, case: dict, fields: dict) -> dict:
    p = kb_query.new_params(0)
    try:
        if case["kind"] == "rows":
            where = kb_query.compile_filter(case.get("filters"), fields, p)
            order = kb_query.compile_sorts(case.get("sorts"), fields, p)
            sql = (f"SELECT id FROM claraos_kb_objects WHERE {where or 'TRUE'} "
                   f"ORDER BY {order}")
        else:
            expr = kb_query.aggregate_expr(case["agg"], case["key"], p)
            where = kb_query.compile_filter(case.get("filters"), fields, p)
            sql = f"SELECT {expr} FROM claraos_kb_objects WHERE {where or 'TRUE'}"
    except kb_query.FilterError as exc:
        return {"error": "filter", "message": str(exc)}
    try:
        if case["kind"] == "rows":
            rows = await conn.fetch(sql, *p.values)
            return {"ok": [r["id"] for r in rows]}
        val = await conn.fetchval(sql, *p.values)
        # Same conversion as the router; repr keeps nan/inf and every bit.
        return {"ok": None if val is None else repr(float(val))}
    except Exception as exc:  # database or driver error -> HTTP 500 on the server
        return {"error": "db", "message": f"{type(exc).__name__}: {exc}"}


async def main() -> None:
    with open(dataset_path, encoding="utf-8") as fh:
        dataset = json.load(fh)
    with open(cases_path, encoding="utf-8") as fh:
        cases = json.load(fh)

    stock = await connect()
    await stock.execute("""
        CREATE TABLE claraos_kb_objects (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            properties JSONB NOT NULL DEFAULT '{}'
        )""")
    await stock.executemany(
        "INSERT INTO claraos_kb_objects (id, title, created_at, updated_at, properties) "
        "VALUES ($1, $2, $3::text::timestamptz, $4::text::timestamptz, $5::text::jsonb)",
        [(r["id"], r["title"], r["created_at"], r["updated_at"], r["properties_json"])
         for r in dataset["rows"]])

    datetext = await connect()
    await datetext.set_type_codec("date", schema="pg_catalog", encoder=str, decoder=str,
                                  format="text")
    info = {
        "today": str(await stock.fetchval("SELECT CURRENT_DATE::text")),
        "server": await stock.fetchval("SHOW server_version"),
        "collate": await stock.fetchval(
            "SELECT datcollate || '/' || datlocprovider::text FROM pg_database "
            "WHERE datname = current_database()"),
        "asyncpg": asyncpg.__version__,
    }

    results = []
    for case in cases:
        fields = case.get("fields") or dataset["fields"]
        results.append({
            "stock": await run_case(stock, case, fields),
            "datetext": await run_case(datetext, case, fields),
        })
    await stock.close()
    await datetext.close()
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"info": info, "results": results}, fh, ensure_ascii=False)


asyncio.run(main())
