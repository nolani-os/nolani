/**
 * useFileOps: batch file operations of the files app.
 *
 * Every action takes a LIST (not just the clicked file), and "paste" after
 * "cut" moves instead of copying. Without this, multi-select + delete hit only
 * one file and cut left the source in place.
 *
 * On name conflicts (API 409) it asks "replace · keep both · skip" and
 * reports partial failures collectively instead of failing silently. Desktop
 * and phone share this layer; dialogs are passed as parameters because each
 * view renders its own useDialogs() instance.
 */
import { useCallback, useState } from "react";
import { i18n, useFileStore, type ConflictMode, type FileOpResult } from "@claraos/core";
import type { ChoiceResult, DialogChoice } from "../../Chat/Dialogs";

export interface OpItem {
  source: string;
  path: string;
}

interface Deps {
  alertDlg: (message: string) => Promise<void>;
  chooseDlg: (message: string, choices: DialogChoice[], checkboxLabel?: string) => Promise<ChoiceResult | null>;
}

export interface OpSummary {
  done: number;
  skipped: number;
  failed: { name: string; why: string }[];
  cancelled: boolean;
}

const leaf = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const parentOf = (p: string) => p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
const norm = (p: string) => "/" + p.replace(/^\/+|\/+$/g, "");

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(`files:${key}`, opts);

/** Built per prompt, so the labels follow the current UI language. */
const conflictChoices = (): DialogChoice[] => [
  { value: "skip", label: tr("ops.conflict.skip") },
  { value: "overwrite", label: tr("ops.conflict.overwrite") },
  { value: "rename", label: tr("ops.conflict.rename"), primary: true },
];

/** "N of M done.\n\nFailed:\n" header of the partial-failure alert. */
const failureHeader = (summaryKey: string, done: number, total: number) =>
  `${tr(summaryKey, { done, total })}\n\n${tr("ops.failedHeader")}\n`;

/** Upload in progress (for the progress indicator). */
export interface UploadState {
  name: string;
  index: number;
  count: number;
  /** 0–1 for the current file */
  fraction: number;
}

/** Upload one file streamed (raw PUT, no form, no 10 MB limit). */
function putFile(url: string, file: File, onProgress: (f: number) => void): Promise<{ ok: boolean; status: number; detail: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let detail = "";
      try { const d = JSON.parse(xhr.responseText)?.detail; detail = typeof d === "string" ? d : d?.message ?? ""; } catch { /* not JSON */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, detail });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, detail: tr("ops.connectionLost") });
    xhr.send(file);
  });
}

export function useFileOps({ alertDlg, chooseDlg }: Deps) {
  const [upload, setUpload] = useState<UploadState | null>(null);
  /** Copy or move a list into a target folder. */
  const transfer = useCallback(async (
    action: "copy" | "move", items: OpItem[], dstSource: string, dstFolder: string,
  ): Promise<OpSummary> => {
    const st = useFileStore.getState();
    const sum: OpSummary = { done: 0, skipped: 0, failed: [], cancelled: false };
    let sticky: ConflictMode | null = null;

    const run = (it: OpItem, mode: ConflictMode): Promise<FileOpResult> => action === "copy"
      ? st.copyFile(it.source, it.path, dstSource, dstFolder, mode, false)
      : st.moveFile(it.source, it.path, dstSource, `${norm(dstFolder).replace(/\/$/, "")}/${leaf(it.path)}`, mode, false);

    for (const it of items) {
      // Moving to the same location is a no-op
      if (action === "move" && it.source === dstSource && norm(parentOf(it.path)) === norm(dstFolder)) {
        sum.skipped++;
        continue;
      }
      let r = await run(it, sticky ?? "fail");
      if (!r.ok && r.conflict?.code === "exists") {
        const pick = await chooseDlg(
          tr("ops.existsInTarget", { name: r.conflict.name ?? leaf(it.path) }),
          conflictChoices(),
          items.length > 1 ? tr("ops.applyToAll") : undefined,
        );
        if (!pick) { sum.cancelled = true; break; }
        if (pick.checked) sticky = pick.value as ConflictMode;
        r = await run(it, pick.value as ConflictMode);
      }
      if (r.ok && r.skipped) sum.skipped++;
      else if (r.ok) sum.done++;
      else sum.failed.push({ name: leaf(it.path), why: r.conflict?.message ?? r.message ?? `HTTP ${r.status}` });
    }

    st.loadTree();
    if (sum.failed.length > 0) {
      await alertDlg(
        failureHeader(action === "copy" ? "ops.summary.copied" : "ops.summary.moved", sum.done, items.length)
        + sum.failed.map((f) => `• ${f.name} — ${f.why}`).join("\n"),
      );
    }
    return sum;
  }, [alertDlg, chooseDlg]);

  /** Delete a list (Nextcloud: to the trash, unless permanent). */
  const remove = useCallback(async (source: string, paths: string[], permanent = false): Promise<OpSummary> => {
    const st = useFileStore.getState();
    const sum: OpSummary = { done: 0, skipped: 0, failed: [], cancelled: false };
    for (const p of paths) {
      if (await st.deleteFile(source, p, false, permanent)) sum.done++;
      else sum.failed.push({ name: leaf(p), why: tr("ops.deleteFailed") });
    }
    st.clearSelection();
    st.loadTree();
    if (sum.failed.length > 0) {
      await alertDlg(failureHeader("ops.summary.deleted", sum.done, paths.length)
        + sum.failed.map((f) => `• ${f.name}`).join("\n"));
    }
    return sum;
  }, [alertDlg]);

  /** Paste the clipboard here; "cut" MOVES. */
  const paste = useCallback(async (dstSource: string, dstFolder: string): Promise<OpSummary | null> => {
    const st = useFileStore.getState();
    const cb = st.clipboard;
    if (!cb || cb.paths.length === 0) return null;
    const sum = await transfer(cb.action === "cut" ? "move" : "copy",
      cb.paths.map((path) => ({ source: cb.source, path })), dstSource, dstFolder);
    // After a move the paths are no longer there: clear the clipboard,
    // unless the operation was cancelled (then the rest stays pasteable).
    if (cb.action === "cut" && !sum.cancelled) st.clearClipboard();
    return sum;
  }, [transfer]);

  /** Upload files: streamed, with progress and conflict prompt.
   *  The UI checks conflicts BEFOREHAND against the displayed list, otherwise
   *  a large file would be transferred completely only to get a 409. */
  const uploadFiles = useCallback(async (files: File[], source: string, dir: string): Promise<OpSummary> => {
    const sum: OpSummary = { done: 0, skipped: 0, failed: [], cancelled: false };
    const st = useFileStore.getState();
    const shown = st.tree && norm(st.tree.path || "/") === norm(dir) && st.activeSource === source
      ? new Set((st.tree.children ?? []).map((c) => c.name.toLowerCase())) : new Set<string>();
    let sticky: ConflictMode | null = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      let mode: ConflictMode = "fail";
      if (shown.has(f.name.toLowerCase())) {
        if (sticky) mode = sticky;
        else {
          const pick = await chooseDlg(tr("ops.existsHere", { name: f.name }), conflictChoices(),
            files.length > 1 ? tr("ops.applyToAll") : undefined);
          if (!pick) { sum.cancelled = true; break; }
          mode = pick.value as ConflictMode;
          if (pick.checked) sticky = mode;
        }
        if (mode === "skip") { sum.skipped++; continue; }
      }
      setUpload({ name: f.name, index: i, count: files.length, fraction: 0 });
      const q = new URLSearchParams({ source, path: dir || "/", name: f.name, on_conflict: mode });
      const r = await putFile(`/api/claraos/files/v2/upload-stream?${q.toString()}`, f,
        (fraction) => setUpload({ name: f.name, index: i, count: files.length, fraction }));
      if (r.ok) sum.done++;
      else sum.failed.push({ name: f.name, why: r.status === 409 ? tr("ops.alreadyExists") : r.detail || `HTTP ${r.status}` });
    }
    setUpload(null);
    st.loadTree();
    if (sum.failed.length > 0) {
      await alertDlg(failureHeader("ops.summary.uploaded", sum.done, files.length)
        + sum.failed.map((x) => `• ${x.name} — ${x.why}`).join("\n"));
    }
    return sum;
  }, [alertDlg, chooseDlg]);

  return { transfer, remove, paste, uploadFiles, upload };
}
