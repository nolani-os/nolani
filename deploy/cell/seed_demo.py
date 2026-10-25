"""Demo-Daten für das GitHub-Schaufenster — läuft IM claraos-api-Container der Zelle.

    docker compose exec -T claraos-api python3 - zelle-test < seed_demo.py

Ruft dieselben Werkzeug-Endpunkte wie das Gehirn (Service-Token + X-Claraos-User).
Inhalte bewusst englisch und fiktiv. Gibt keine Geheimnisse aus.
"""
import datetime as dt
import json
import os
import sys
import urllib.request

USER = sys.argv[1]
BASE = "http://localhost:8090"
H = {"Content-Type": "application/json", "X-ClaraOS-Service-Token": os.environ["CLARAOS_SERVICE_TOKEN"],
     "X-Claraos-User": USER}
heute = dt.date.today()
montag = heute - dt.timedelta(days=heute.weekday())
if heute.weekday() >= 5:  # weekend: show the coming week, not the past one
    montag += dt.timedelta(days=7)


def tag(n: int, uhr: str | None = None) -> str:
    d = (montag + dt.timedelta(days=n)).isoformat()
    return f"{d}T{uhr}" if uhr else d


def post(pfad: str, body: dict | None, method: str = "POST") -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + pfad, data=data, headers=H, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        print("FEHLER", pfad, e.code, e.read()[:200].decode(errors="replace"))
        return {}


plaene = [
    ("Website relaunch", "New website for Q4 — design, content, launch.", [
        ("Collect feedback on the new homepage", tag(0)), ("Finalise the colour palette", tag(1)),
        ("Write the About page", tag(2)), ("Send proposal to Miller & Co.", tag(4)),
        ("Migrate the blog posts", tag(7)), ("Launch 🚀", tag(11))]),
    ("Family", "Things at home.", [
        ("Book the summer holiday", tag(3)), ("Renew the car insurance", tag(5)),
        ("Birthday present for Mia", tag(6))]),
    ("Q4 planning", "Budget and goals for next quarter.", [
        ("Draft the Q4 budget", tag(2)), ("Review numbers with the team", tag(3)),
        ("Present the plan", tag(8))]),
]
for titel, beschreibung, aufgaben in plaene:
    r = post("/api/claraos/planner/clara/create_project_from_plan", {
        "title": titel, "description": beschreibung,
        "tasks": [{"title": t, "due_date": d} for t, d in aufgaben]})
    print("PROJEKT", titel, bool(r))

for summary, start, end, ort in [
    ("Team sync", tag(0, "09:30"), tag(0, "10:00"), "Video call"),
    ("Design review — website", tag(1, "14:00"), tag(1, "15:00"), "Teams"),
    ("Lunch with Sarah", tag(2, "12:30"), tag(2, "13:30"), "Café Central"),
    ("Dentist", tag(3, "08:00"), tag(3, "08:45"), ""),
    ("Q4 planning workshop", tag(3, "13:00"), tag(3, "16:00"), "Office"),
    ("Kids' football", tag(4, "17:00"), tag(4, "18:30"), "Sports ground"),
    ("Proposal call with Miller & Co.", tag(4, "11:00"), tag(4, "11:30"), "Phone"),
]:
    r = post("/api/claraos/nc/calendar/add", {"summary": summary, "start": start, "end": end, "location": ort})
    print("TERMIN", summary, bool(r))

for name, mail, org in [("Sarah Chen", "sarah@example.com", "Studio North"),
                        ("Tom Miller", "tom@miller.example", "Miller & Co."),
                        ("Mia", "", "")]:
    print("KONTAKT", name, bool(post("/api/claraos/nc/contacts/add",
                                      {"full_name": name, "email": mail, "org": org})))

BRIEF = """# Website relaunch — project brief

## Goal
A faster, friendlier website that explains our services in one minute and brings in
at least 20 qualified enquiries a month.

## Scope
- New homepage, services and about pages
- Blog migration (42 posts)
- Contact form connected to the shared inbox

## Timeline
- Week 1: feedback and design decisions
- Week 2: content and migration
- Week 3: launch and monitoring

## Budget
EUR 12,000 including design, copywriting and hosting for one year.

## Risks
- Content is late because everyone is busy with Q4 planning
- Old blog links break — we need redirects
"""
print("DOKUMENT", bool(post("/api/claraos/office/create-document", {
    "filename": "Project brief.docx", "folder": "/Projects/Website relaunch",
    "title": "Website relaunch — project brief", "content_markdown": BRIEF})))
print("DOKUMENT", bool(post("/api/claraos/office/create-document", {
    "filename": "Q4 budget draft.docx", "folder": "/Projects/Q4 planning",
    "title": "Q4 budget draft", "content_markdown": "# Q4 budget draft\n\n| Item | EUR |\n|---|---|\n| Website | 12,000 |\n| Events | 4,500 |\n| Tools | 1,800 |\n"})))
post("/api/claraos/files/v2/mkdir?source=nextcloud&path=/Notes", {})
for pfad, inhalt in [
    ("/Projects/Website relaunch/Homepage feedback.md",
     "# Homepage feedback\n\n- Sarah: hero image too dark\n- Tom: pricing hard to find\n- Mia: love the new logo\n"),
    ("/Notes/Holiday ideas.md", "# Holiday ideas\n\n- Lake Garda\n- Lisbon in spring\n- Hiking in the Alps\n"),
]:
    print("DATEI", pfad, bool(post("/api/claraos/files/v2/write", {"source": "nextcloud", "path": pfad, "content": inhalt})))

for titel, text in [("Newsletter for existing customers", "Monthly, short, one useful tip each time."),
                    ("Self-service booking on the website", "Let clients book a call without e-mail ping-pong.")]:
    print("IDEE", titel, bool(post("/api/claraos/knowledge/clara/capture_idea", {"title": titel, "body": text})))

# A table collection for the knowledge app shot — same shape as the "Rezepte" template
# (fields in the collection's own registry, examples as objects in the collection).
FT_TEXT, FT_NUMBER, FT_SELECT, FT_MULTI, FT_CHECK = 0, 1, 3, 4, 6
# The test account outlives a run: an earlier "Recipes" would show twice in the
# sidebar (take 8). Remove it with its entries first.
for alt in post("/api/claraos/knowledge/collections", None, "GET").get("collections", []):
    if alt.get("name") == "Recipes":
        for zeile in post(f"/api/claraos/knowledge/collections/{alt['id']}/rows", None, "GET").get("rows", []):
            post(f"/api/claraos/knowledge/objects/{zeile['id']}", None, "DELETE")
        post(f"/api/claraos/knowledge/collections/{alt['id']}", None, "DELETE")
        print("SAMMLUNG alte Recipes entfernt", alt["id"])
coll = post("/api/claraos/knowledge/collections", {
    "name": "Recipes", "icon": "🍲", "default_type": "note", "visibility": "private",
    "description": "What goes down well at home — with time, effort and rating."}).get("collection") or {}
if coll.get("id"):
    cid = coll["id"]
    for key, name, ft, opt in [
        ("time", "Time (min)", FT_NUMBER, None),
        ("effort", "Effort", FT_SELECT, ["Quick", "Medium", "Weekend project"]),
        ("diet", "Diet", FT_MULTI, ["Vegetarian", "Vegan", "Fish", "Meat"]),
        ("rating", "Rating", FT_SELECT, ["★★★", "★★★★", "★★★★★"]),
        ("loved_by", "Loved by", FT_TEXT, None),
        ("favourite", "Favourite", FT_CHECK, None),
    ]:
        post(f"/api/claraos/knowledge/collections/{cid}/fields",
             {"key": key, "name": name, "field_type": ft,
              **({"type_option": {"options": opt}} if opt else {})})
    rezepte = [
        ("Sheet-pan vegetables with feta", 40, "Quick", ["Vegetarian"], "★★★★★", "Everyone", True),
        ("Thai green curry", 35, "Quick", ["Vegan"], "★★★★", "Alex", True),
        ("Lemon salmon with herbs", 25, "Quick", ["Fish"], "★★★★", "Sam", False),
        ("Homemade lasagne", 90, "Medium", ["Meat"], "★★★★★", "Kids", True),
        ("Mushroom risotto", 45, "Medium", ["Vegetarian"], "★★★", "Alex", False),
        ("Sunday roast", 180, "Weekend project", ["Meat"], "★★★★", "Grandparents", False),
    ]
    for i, (titel, dauer, aufwand, diaet, wertung, wer, liebling) in enumerate(rezepte):
        obj = post("/api/claraos/knowledge/objects", {
            "type": "note", "title": titel, "visibility": "private",
            "body": f"# {titel}\n\nIngredients and steps go here.\n",
            "properties": {"time": dauer, "effort": aufwand, "diet": diaet, "rating": wertung,
                           "loved_by": wer, "favourite": liebling}}).get("object") or {}
        if obj.get("id"):
            post(f"/api/claraos/knowledge/collections/{cid}/items", {"object_id": obj["id"], "position": i + 1})
    # The server names the default view "Alle Einträge" (data, not UI text) — the
    # English demo calls it "All entries". The first GET creates it.
    for ansicht in post(f"/api/claraos/knowledge/collections/{cid}/views", None, "GET").get("views", []):
        if ansicht.get("name") == "Alle Einträge":
            post(f"/api/claraos/knowledge/collections/{cid}/views/{ansicht['id']}",
                 {"name": "All entries"}, "PATCH")
    print("SAMMLUNG Recipes", cid, len(rezepte))
else:
    print("SAMMLUNG Recipes FEHLT")
print("FERTIG")
