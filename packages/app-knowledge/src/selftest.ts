/**
 * Built-in self-test for headless checks of the native app (VITE_SELFTEST=1).
 *
 * Runs through the same paths a person uses — REST contract, page tree, search,
 * then the real editor — and prints the outcome as a banner, so a screenshot of
 * the window is the evidence. Run the app twice: the second run must find the
 * data of the first, which proves the database file persists.
 */
const K = "/api/claraos/knowledge";

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(K + path, {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function banner(lines: string[], ok: boolean) {
  const el = document.createElement("pre");
  el.id = "selftest";
  el.textContent = lines.join("\n");
  Object.assign(el.style, {
    position: "fixed", right: "12px", bottom: "12px", zIndex: "99999", margin: "0", padding: "12px 16px",
    font: "14px/1.4 monospace", color: "#fff", background: ok ? "#14532d" : "#7f1d1d",
    border: "2px solid #fff", borderRadius: "8px", maxWidth: "560px", whiteSpace: "pre-wrap",
  });
  document.body.appendChild(el);
}

function clickText(text: string): boolean {
  const el = [...document.querySelectorAll<HTMLElement>("button, a, [role=button], span, div")]
    .find((e) => e.children.length === 0 && e.textContent?.trim() === text);
  el?.click();
  return !!el;
}

export async function runSelftest(driver: string) {
  const lines = [`driver: ${driver}`, `engine: ${navigator.userAgent.match(/AppleWebKit\/[\d.]+/)?.[0] ?? "?"}`];
  let ok = driver === "native";
  try {
    const before = (await call("GET", "/objects?type=note")).objects.length as number;
    if (before === 0) {
      // Seed, then reload once so the app's lists show the new pages.
      const a = await call("POST", "/objects", { type: "note", title: "Nativ gespeichert", body: "Grüße aus der Datenbankdatei" });
      await call("POST", "/objects", { type: "note", title: "Unterseite", body: "Kind", parent_id: a.object.id });
      sessionStorage.setItem("selftest-run", "1");
      location.reload();
      return;
    }
    const run = sessionStorage.getItem("selftest-run") === "1" ? 1 : 2;
    lines.push(`run: ${run} (notes found at start: ${before})`);
    const hits = (await call("GET", "/search?q=grüße")).results.length;
    const kids = (await call("GET", "/objects?type=note")).objects.length;
    lines.push(`search 'grüße': ${hits} · notes: ${kids}`);
    ok &&= hits === 1 && kids === 2;

    // Through the UI: open the page and type into the editor.
    await sleep(800);
    clickText("Notes");
    await sleep(1200);
    clickText("Nativ gespeichert");
    await sleep(2000);
    const ed = [...document.querySelectorAll<HTMLElement>("[contenteditable=true]")].pop();
    if (ed) {
      ed.focus();
      const sel = window.getSelection();
      sel?.selectAllChildren(ed);
      sel?.collapseToEnd();
      document.execCommand("insertText", false, ` Lauf ${run} getippt.`);
      await sleep(3500);
      const page = (await call("GET", "/objects?type=note")).objects.find((o: { title: string }) => o.title === "Nativ gespeichert");
      const body = (await call("GET", `/objects/${page.id}`)).object.body as string;
      const typed = (body.match(/Lauf \d getippt/g) ?? []).join(", ");
      lines.push(`editor: found · saved text: ${typed || "—"}`);
      ok &&= body.includes(`Lauf ${run} getippt`);
      // The second launch must still see what the first one typed.
      if (run === 2) ok &&= body.includes("Lauf 1 getippt");
      sessionStorage.removeItem("selftest-run");
    } else {
      lines.push("editor: NOT FOUND");
      ok = false;
    }
  } catch (e) {
    lines.push(`error: ${e instanceof Error ? e.message : String(e)}`);
    ok = false;
  }
  lines.unshift(ok ? "SELFTEST OK" : "SELFTEST FAILED");
  banner(lines, ok);
}
