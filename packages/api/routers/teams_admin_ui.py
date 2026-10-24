"""Minimal HTML admin UI for ClaraOS Teams — served from FastAPI, no build.

URL: /v1/admin/teams/ui (admin-only, forward_auth via Caddy injects headers)

This is intentionally a single-page HTML with inline vanilla JS to avoid
bringing in the shell-build-chain. A proper React integration into
UserAdminApp.tsx is planned.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from auth import get_current_user

router = APIRouter(prefix="/api/claraos/v1/admin/teams", tags=["teams-admin-ui"])


HTML = r"""<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<title>""" + PRODUCT_NAME + r""" Teams Admin</title>
<style>
  :root {
    --bg:#1e1e2e; --panel:#28283c; --accent:#7fd1f5; --accent2:#c4a7e7;
    --ok:#a6e3a1; --warn:#fab387; --err:#f38ba8;
    --text:#cdd6f4; --muted:#6c7086; --border:#45475a;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:14px}
  .wrap{max-width:1200px;margin:0 auto;padding:20px}
  h1{font-size:18px;margin:0 0 16px 0;color:var(--accent)}
  .bar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  button{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px}
  button:hover{border-color:var(--accent)}
  button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent);font-weight:600}
  button.danger{background:var(--err);color:var(--bg);border-color:var(--err)}
  input,select{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:13px;min-width:200px}
  input:focus,select:focus{outline:none;border-color:var(--accent)}
  .grid{display:grid;grid-template-columns:minmax(300px,1fr) 2fr;gap:16px}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px}
  .panel h2{font-size:14px;margin:0 0 10px 0;color:var(--accent2);text-transform:uppercase;letter-spacing:0.5px}
  .tree{list-style:none;padding:0;margin:0}
  .tree li{padding:6px 10px;cursor:pointer;border-radius:4px;margin-bottom:2px;display:flex;justify-content:space-between;align-items:center}
  .tree li:hover{background:rgba(127,209,245,0.1)}
  .tree li.active{background:rgba(127,209,245,0.2);border-left:3px solid var(--accent)}
  .tree .slug{font-family:monospace;color:var(--muted);font-size:12px}
  .depth1{padding-left:20px}.depth2{padding-left:40px}.depth3{padding-left:60px}.depth4{padding-left:80px}.depth5{padding-left:100px}
  .row{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)}
  .row:last-child{border-bottom:none}
  .row .user{flex:1;font-family:monospace}
  .status{padding:10px;border-radius:6px;margin:8px 0}
  .status.ok{background:rgba(166,227,161,0.15);border:1px solid var(--ok);color:var(--ok)}
  .status.err{background:rgba(243,139,168,0.15);border:1px solid var(--err);color:var(--err)}
  .tabs{display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--border)}
  .tabs button{border-radius:6px 6px 0 0;border-bottom:none}
  .tabs button.active{background:var(--panel);border-bottom:2px solid var(--accent)}
  .audit{font-family:monospace;font-size:12px;max-height:300px;overflow:auto}
  .audit .e{padding:4px 0;border-bottom:1px dashed var(--border)}
  .audit .t{color:var(--muted)}
  .kv{display:grid;grid-template-columns:120px 1fr;gap:4px 12px;margin:12px 0;font-size:13px}
  .kv dt{color:var(--muted)}
  .kv dd{margin:0;font-family:monospace;word-break:break-all}
  .empty{color:var(--muted);text-align:center;padding:20px}
  dialog{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:20px;min-width:400px}
  dialog::backdrop{background:rgba(0,0,0,0.6)}
  dialog h3{margin:0 0 12px 0;color:var(--accent)}
  .form{display:grid;grid-template-columns:120px 1fr;gap:8px 12px;align-items:center}
  .form label{color:var(--muted)}
  .form input[type=checkbox]{min-width:auto}
  .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🛡 """ + PRODUCT_NAME + r""" Teams Admin</h1>

  <div id="status"></div>

  <div class="bar">
    <button class="primary" onclick="openCreate()">+ Neues Team</button>
    <button onclick="openImport()">📥 Aus Nextcloud importieren</button>
    <button onclick="loadTeams()">⟳ Neu laden</button>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Teams</h2>
      <ul id="tree" class="tree"></ul>
    </div>
    <div class="panel" id="detail">
      <h2>Details</h2>
      <div class="empty">Team links auswählen</div>
    </div>
  </div>
</div>

<!-- Create Dialog -->
<dialog id="dlgCreate">
  <h3>Neues Team erstellen</h3>
  <div class="form">
    <label>Slug*</label><input id="c_slug" placeholder="z.B. engineering.backend" maxlength="64"/>
    <label>Name*</label><input id="c_name" placeholder="Engineering Backend"/>
    <label>Beschreibung</label><input id="c_desc" placeholder="optional"/>
    <label>Parent-Slug</label><input id="c_parent" placeholder="leer = Wurzel-Team"/>
    <label>NC Circle</label><input id="c_circle" type="checkbox" checked/>
    <label>NC GroupFolder</label><input id="c_gf" type="checkbox"/>
    <label>Members erben</label><input id="c_inherit" type="checkbox"/>
    <label>Clara.bot einladen</label><input id="c_clara" type="checkbox"/>
  </div>
  <div class="actions">
    <button onclick="document.getElementById('dlgCreate').close()">Abbrechen</button>
    <button class="primary" onclick="doCreate()">Erstellen</button>
  </div>
</dialog>

<!-- Import Dialog -->
<dialog id="dlgImport">
  <h3>Aus Nextcloud importieren</h3>
  <div id="importList" class="empty">Lade...</div>
  <div class="actions">
    <button onclick="document.getElementById('dlgImport').close()">Schließen</button>
  </div>
</dialog>

<!-- Upgrade Dialog -->
<dialog id="dlgUpgrade">
  <h3>Resources nachrüsten</h3>
  <div class="form">
    <label>Team</label><input id="u_slug" readonly/>
    <label>GroupFolder</label><input id="u_gf" type="checkbox"/>
    <label>Kalender</label><input id="u_cal" type="checkbox"/>
    <label>Plan (Deck)</label><input id="u_deck" type="checkbox"/>
    <label>Wiki (Collective)</label><input id="u_coll" type="checkbox"/>
  </div>
  <div class="actions">
    <button onclick="document.getElementById('dlgUpgrade').close()">Abbrechen</button>
    <button class="primary" onclick="doUpgrade()">Upgrade</button>
  </div>
</dialog>

<!-- Add-Member Dialog -->
<dialog id="dlgMember">
  <h3>Mitglied hinzufügen</h3>
  <div class="form">
    <label>Team</label><input id="m_slug" readonly/>
    <label>Username</label><input id="m_user" placeholder="authentik-username"/>
  </div>
  <div class="actions">
    <button onclick="document.getElementById('dlgMember').close()">Abbrechen</button>
    <button class="primary" onclick="doAddMember()">Hinzufügen</button>
  </div>
</dialog>

<script>
const API = "/api/claraos/v1/admin/teams";
let TEAMS = [];
let SELECTED = null;

function setStatus(msg, cls="ok") {
  const el = document.getElementById("status");
  el.innerHTML = `<div class="status ${cls}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ""; }, 4000);
}

async function api(method, path, body) {
  const opts = { method, credentials: "include", headers: {} };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(API + path, opts);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch(e) {}
    throw new Error(msg);
  }
  return r.json();
}

async function loadTeams() {
  try {
    TEAMS = await api("GET", "");
    renderTree();
    if (SELECTED) selectTeam(SELECTED);
  } catch (e) { setStatus("Fehler: " + e.message, "err"); }
}

function renderTree() {
  const ul = document.getElementById("tree");
  if (!TEAMS.length) { ul.innerHTML = '<li class="empty">Keine Teams</li>'; return; }
  // Sort hierarchically: by slug alphabetically (dots make sub-teams appear under parents)
  const sorted = [...TEAMS].sort((a,b) => a.slug.localeCompare(b.slug));
  ul.innerHTML = sorted.map(t => {
    const cls = `depth${t.depth}${t.slug === SELECTED ? ' active' : ''}`;
    return `<li class="${cls}" data-slug="${t.slug}">
      <span><strong>${escape(t.name)}</strong> <span class="slug">${t.slug}</span></span>
      <span class="slug">d=${t.depth}</span>
    </li>`;
  }).join("");
  ul.querySelectorAll("li[data-slug]").forEach(li => {
    li.onclick = () => selectTeam(li.dataset.slug);
  });
}

async function selectTeam(slug) {
  SELECTED = slug;
  document.querySelectorAll("#tree li").forEach(li => li.classList.toggle("active", li.dataset.slug === slug));
  const detail = document.getElementById("detail");
  detail.innerHTML = '<h2>Details</h2><div class="empty">Lade...</div>';
  try {
    const t = await api("GET", `/${slug}`);
    const audit = await api("GET", `/${slug}/audit?limit=20`);
    detail.innerHTML = `
      <h2>${escape(t.name)}</h2>
      <dl class="kv">
        <dt>Slug</dt><dd>${t.slug}</dd>
        <dt>Tiefe</dt><dd>${t.depth}</dd>
        <dt>Authentik-Gruppe</dt><dd>${t.authentik_group_pk||'–'}</dd>
        <dt>Matrix-Space</dt><dd>${t.matrix_space_id||'–'}</dd>
        <dt>NC-Circle</dt><dd>${t.nc_circle_id||'–'}</dd>
        <dt>NC-GroupFolder</dt><dd>${t.nc_groupfolder_id||'–'}</dd>
        <dt>Inherit</dt><dd>${t.inherit_members?'✓':'–'}</dd>
        <dt>Status</dt><dd>${t.status}</dd>
        <dt>Erstellt</dt><dd>${new Date(t.created_at).toLocaleString('de-DE')} von ${t.created_by}</dd>
      </dl>

      <div class="bar">
        <strong>Mitglieder (${t.members.length})</strong>
        <button onclick="openMember('${slug}')">+ Mitglied</button>
        <button onclick="openUpgrade('${slug}', ${JSON.stringify({gf: !!t.nc_groupfolder_id, cal: !!t.nc_calendar_uri, deck: !!t.nc_deck_board_id, coll: !!t.nc_collective_id}).replace(/"/g,'&quot;')})">⬆ Resources</button>
        <span style="flex:1"></span>
        <button class="danger" onclick="doDelete('${slug}')">Team löschen</button>
      </div>
      <div>
        ${t.members.map(u => `
          <div class="row">
            <span class="user">${u}</span>
            <button onclick="doRemoveMember('${slug}','${u}')">✕</button>
          </div>
        `).join("") || '<div class="empty">Keine Mitglieder</div>'}
      </div>

      <h2 style="margin-top:20px">Audit-Log</h2>
      <div class="audit">
        ${audit.map(e => `
          <div class="e">
            <span class="t">${new Date(e.at).toLocaleString('de-DE')}</span>
            · <strong>${e.event}</strong>
            ${e.target? '→ ' + e.target : ''}
            · ${e.actor}
          </div>
        `).join("") || '<div class="empty">Kein Audit</div>'}
      </div>
    `;
  } catch (e) {
    detail.innerHTML = `<div class="status err">${e.message}</div>`;
  }
}

function escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function openCreate() {
  ["c_slug","c_name","c_desc","c_parent"].forEach(id => document.getElementById(id).value = "");
  ["c_circle"].forEach(id => document.getElementById(id).checked = true);
  ["c_gf","c_inherit","c_clara"].forEach(id => document.getElementById(id).checked = false);
  document.getElementById("dlgCreate").showModal();
}

async function doCreate() {
  const body = {
    slug: document.getElementById("c_slug").value.trim(),
    name: document.getElementById("c_name").value.trim(),
    description: document.getElementById("c_desc").value.trim() || null,
    parent_slug: document.getElementById("c_parent").value.trim() || null,
    with_nc_circle: document.getElementById("c_circle").checked,
    with_groupfolder: document.getElementById("c_gf").checked,
    inherit_members: document.getElementById("c_inherit").checked,
    include_clara_bot: document.getElementById("c_clara").checked,
  };
  if (!body.slug || !body.name) { setStatus("Slug + Name nötig", "err"); return; }
  try {
    const r = await api("POST", "", body);
    document.getElementById("dlgCreate").close();
    setStatus(`Team ${r.slug} erstellt`);
    await loadTeams();
    selectTeam(r.slug);
  } catch (e) { setStatus("Fehler: " + e.message, "err"); }
}

async function doDelete(slug) {
  if (!confirm(`Team "${slug}" wirklich löschen? Cascade auf alle Mirrors.`)) return;
  try {
    const r = await api("DELETE", `/${slug}`);
    setStatus(`${slug} gelöscht${r.mirror_errors?.length ? ' (mit Mirror-Warnings: ' + r.mirror_errors.length + ')' : ''}`);
    SELECTED = null;
    await loadTeams();
    document.getElementById("detail").innerHTML = '<h2>Details</h2><div class="empty">Team links auswählen</div>';
  } catch (e) { setStatus("Fehler: " + e.message, "err"); }
}

function openMember(slug) {
  document.getElementById("m_slug").value = slug;
  document.getElementById("m_user").value = "";
  document.getElementById("dlgMember").showModal();
}

async function doAddMember() {
  const slug = document.getElementById("m_slug").value;
  const user = document.getElementById("m_user").value.trim();
  if (!user) return;
  try {
    await api("POST", `/${slug}/members`, { username: user });
    document.getElementById("dlgMember").close();
    setStatus(`${user} → ${slug}`);
    await selectTeam(slug);
  } catch (e) { setStatus("Fehler: " + e.message, "err"); }
}

async function doRemoveMember(slug, user) {
  if (!confirm(`${user} aus ${slug} entfernen?`)) return;
  try {
    await api("DELETE", `/${slug}/members/${encodeURIComponent(user)}`);
    setStatus(`${user} entfernt`);
    await selectTeam(slug);
  } catch (e) { setStatus("Fehler: " + e.message, "err"); }
}

function openUpgrade(slug, has) {
  document.getElementById("u_slug").value = slug;
  // Hide checkboxes for already-provisioned resources
  const rows = [["u_gf", has.gf], ["u_cal", has.cal], ["u_deck", has.deck], ["u_coll", has.coll]];
  for (const [id, present] of rows) {
    const cb = document.getElementById(id);
    cb.checked = false;
    cb.disabled = present;
    cb.parentElement?.previousElementSibling && (cb.parentElement.previousElementSibling.style.opacity = present ? "0.4" : "1");
  }
  document.getElementById("dlgUpgrade").showModal();
}

async function doUpgrade() {
  const slug = document.getElementById("u_slug").value;
  const body = {
    enable_groupfolder: document.getElementById("u_gf").checked,
    enable_calendar: document.getElementById("u_cal").checked,
    enable_deck: document.getElementById("u_deck").checked,
    enable_collective: document.getElementById("u_coll").checked,
  };
  try {
    const r = await api("POST", `/${slug}/upgrade`, body);
    document.getElementById("dlgUpgrade").close();
    const addedKeys = Object.keys(r.added || {});
    setStatus(`${slug}: added ${addedKeys.length ? addedKeys.join(", ") : "(nothing — all already present)"}`);
    await loadTeams();
    selectTeam(slug);
  } catch (e) { setStatus("Fehler: " + e.message, "err"); }
}

async function openImport() {
  document.getElementById("dlgImport").showModal();
  const box = document.getElementById("importList");
  box.innerHTML = '<div class="empty">Lade...</div>';
  try {
    const list = await api("GET", "/nc-import/preview");
    if (!list.length) { box.innerHTML = '<div class="empty">Keine unsynced Circles</div>'; return; }
    box.innerHTML = list.map(c => `
      <div class="row">
        <span class="user"><strong>${escape(c.name)}</strong> · ${c.population} Mitglieder · owner: ${c.owner_username||'?'}</span>
        <button onclick="doImport('${c.id}', '${escape(c.name).toLowerCase().replace(/[^a-z0-9.-]/g,'-')}','${escape(c.name)}')">Importieren</button>
      </div>
    `).join("");
  } catch (e) { box.innerHTML = `<div class="status err">${e.message}</div>`; }
}

async function doImport(circleId, slug, name) {
  const slugIn = prompt(`Slug für das importierte Team:`, slug);
  if (!slugIn) return;
  try {
    const r = await api("POST", `/nc-import/${circleId}`, { slug: slugIn, name });
    document.getElementById("dlgImport").close();
    setStatus(`Import: ${r.imported_users.length} User, ${r.missing_authentik_users.length} fehlten`);
    await loadTeams();
    selectTeam(r.slug);
  } catch (e) { setStatus("Fehler: " + e.message, "err"); }
}

loadTeams();
</script>
</body>
</html>
"""


@router.get("/ui", response_class=HTMLResponse)
async def teams_ui(request: Request) -> HTMLResponse:
    user = get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(403, "admin role required")
    return HTMLResponse(content=HTML)
