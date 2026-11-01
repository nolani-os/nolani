#!/bin/sh
# Native end-to-end test of the local HTTP API (src-tauri/src/api.rs + src/localApi.ts).
# Runs the built Linux binary under Xvfb inside the desktop build image, switches the
# API on in the app database with a test key, and checks guards and contract with curl.
# Run from the build directory that contains src-tauri/target/release (mounted as /w):
#   docker run --rm -v "$PWD":/w claraos-desktop-build:2604 sh /w/api.native.sh
# Needs xvfb-run, dbus-run-session, curl and python3 in the image. Exit summary: "== N ok, M fehlgeschlagen".
set -u
export HOME=/w/apitest; rm -rf "$HOME"; mkdir -p "$HOME"
APP=/w/src-tauri/target/release/nolani-knowledge
TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n")  # fresh random key per run
K=http://127.0.0.1:7311/api/claraos/knowledge
start() { xvfb-run -a dbus-run-session "$APP" >"$HOME/app.log" 2>&1 & sleep 9; }
stop() { pkill -f "$APP"; sleep 3; pgrep -f "$APP" >/dev/null && echo "WARN: app still running"; }
start; stop
DB=$(find "$HOME" -name knowledge.db | head -1); echo "db=$DB"
python3 - "$DB" "$TOKEN" <<P
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
print("schema", c.execute("PRAGMA user_version").fetchone()[0])
c.executemany("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
              [("api_enabled", "1"), ("api_port", "7311"), ("api_token", sys.argv[2])])
c.commit()
P
start
ok=0; bad=0
t() { if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "OK   $1"; else bad=$((bad+1)); echo "FAIL $1 (got $2, want $3)"; head -c 300 /tmp/out; echo; fi; }
code() { curl -s -o /tmp/out -w '%{http_code}' "$@"; }
A="Authorization: Bearer $TOKEN"
t "ohne Schlüssel 401"         "$(code $K/types)" 401
t "falscher Schlüssel 401"     "$(code -H 'Authorization: Bearer x' $K/types)" 401
t "Browser (Origin) 403"       "$(code -H "$A" -H 'Origin: https://evil.example' $K/types)" 403
t "fremder Host 421"           "$(code -H "$A" -H 'Host: evil.example:7311' $K/types)" 421
t "anderer Pfad 404"           "$(code -H "$A" http://127.0.0.1:7311/api/claraos/other)" 404
t "Typen lesen 200"            "$(code -H "$A" $K/types)" 200
t "Typ note vorhanden"         "$(grep -c '"id": *"note"' /tmp/out)" 1
t "Notiz anlegen 200"          "$(code -H "$A" -H 'Content-Type: application/json' -d '{"title":"Per API","body":"Hallo aus curl"}' $K/objects)" 200
OID=$(python3 -c 'import json;print(json.load(open("/tmp/out"))["object"]["id"])')
t "Notiz lesen 200"            "$(code -H "$A" $K/objects/$OID)" 200
t "Suche findet sie"           "$(code -H "$A" "$K/search?q=curl")" 200
t "Suchtreffer 1"              "$(python3 -c 'import json;print(len(json.load(open("/tmp/out"))["results"]))')" 1
t "kaputtes JSON 400"          "$(code -H "$A" -H 'Content-Type: application/json' -d '{kaputt' $K/objects)" 400
code -H "$A" -H 'Content-Type: application/json' -d '{"name":"API-Sammlung"}' $K/collections >/dev/null
CID=$(python3 -c 'import json;print(json.load(open("/tmp/out"))["collection"]["id"])')
code -H "$A" -H 'Content-Type: application/json' -d '{"key":"preis","name":"Preis","field_type":1}' $K/collections/$CID/fields >/dev/null
t "Formelspalte 200"           "$(code -H "$A" -H 'Content-Type: application/json' -d '{"key":"brutto","name":"Brutto","field_type":14,"type_option":{"expression":"prop(\"preis\") * 2"}}' $K/collections/$CID/fields)" 200
code -H "$A" -H 'Content-Type: application/json' -d "{\"title\":\"Zeile\",\"properties\":{\"preis\":21}}" $K/objects >/dev/null
RID=$(python3 -c 'import json;print(json.load(open("/tmp/out"))["object"]["id"])')
code -H "$A" -H 'Content-Type: application/json' -d "{\"object_id\":\"$RID\"}" $K/collections/$CID/items >/dev/null
t "Zeilen 200"                 "$(code -H "$A" $K/collections/$CID/rows)" 200
t "Formel = 42"                "$(python3 -c 'import json;print(json.load(open("/tmp/out"))["rows"][0]["formulas"]["brutto"])')" 42
printf '\x89PNG\r\n\x1a\nTESTDATA' > /tmp/bild.png
t "Upload multipart 200"       "$(code -H "$A" -F "file=@/tmp/bild.png;type=image/png" $K/objects/$OID/attachments)" 200
URL=$(python3 -c 'import json;print(json.load(open("/tmp/out"))["attachment"]["url"])')
t "Download 200"               "$(curl -s -o /tmp/back.png -w '%{http_code}' -H "$A" "http://127.0.0.1:7311$URL")" 200
t "Download identisch"         "$(cmp -s /tmp/bild.png /tmp/back.png && echo ja)" ja
t "Export 200"                 "$(curl -s -D /tmp/h -o /tmp/ex.zip -w '%{http_code}' -H "$A" $K/export)" 200
t "Export ist ZIP"             "$(head -c 2 /tmp/ex.zip)" PK
t "Content-Disposition"        "$(grep -ci 'content-disposition: attachment' /tmp/h)" 1
IP=$(hostname -i | awk '{print $1}')
t "nicht über $IP erreichbar"  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "$A" http://$IP:7311/api/claraos/knowledge/types)" 000
t "UI sieht API-Notiz (gleiche DB)" "$(python3 -c "
import sqlite3; print(sqlite3.connect('$DB').execute(\"SELECT count(*) FROM objects WHERE title='Per API'\").fetchone()[0])")" 1
stop
t "nach Beenden zu"            "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "$A" $K/types)" 000
echo "== $ok ok, $bad fehlgeschlagen"
grep -iE "panic|error" "$HOME/app.log" | grep -viE "dbind|libEGL|DRI3|MESA|Gtk-WARNING|a11y" | head -5
