/**
 * Archive operations of the files app (ZIP / AES-ZIP / extract), shared
 * between desktop and mobile views. Dialogs are passed in as parameters so
 * each view can use its own useDialogs() instance.
 */
import { useCallback } from "react";
import { useFileStore, type FileNode } from "@claraos/core";

interface ArchiveDeps {
  activeSource: string;
  currentPath: string;
  promptDlg: (message: string) => Promise<string | null>;
  alertDlg: (message: string) => Promise<void>;
}

export function useArchiveOps({ activeSource, currentPath, promptDlg, alertDlg }: ArchiveDeps) {
  const loadTree = useFileStore((s) => s.loadTree);

  const archiveItem = useCallback(async (node: FileNode & { source?: string }) => {
    const r = await fetch("/api/claraos/files/v2/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: node.source ?? activeSource, path: node.path }),
    });
    if (r.ok) loadTree(activeSource, currentPath || "/");
    else await alertDlg(`Archivieren fehlgeschlagen: ${(await r.json().catch(() => ({})))?.detail ?? r.status}`);
  }, [activeSource, currentPath, loadTree, alertDlg]);

  const encryptItem = useCallback(async (node: FileNode & { source?: string }) => {
    const pw = await promptDlg(`Passwort für „${node.name}“ — ohne Passwort ist das Archiv nicht lesbar:`);
    if (!pw) return;
    const r = await fetch("/api/claraos/files/v2/encrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: node.source ?? activeSource, path: node.path, password: pw }),
    });
    if (r.ok) loadTree(activeSource, currentPath || "/");
    else await alertDlg(`Verschlüsseln fehlgeschlagen: ${(await r.json().catch(() => ({})))?.detail ?? r.status}`);
  }, [activeSource, currentPath, loadTree, promptDlg, alertDlg]);

  const extractItem = useCallback(async (node: FileNode & { source?: string }) => {
    const post = (password?: string) =>
      fetch("/api/claraos/files/v2/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: node.source ?? activeSource, path: node.path, ...(password ? { password } : {}) }),
      });
    let r = await post();
    // Encrypted archives: ask for the password, up to 3 attempts on typos
    for (let attempt = 0; !r.ok && attempt < 3; attempt++) {
      const detail = String((await r.json().catch(() => ({})))?.detail ?? "");
      if (!detail.includes("Passwort erforderlich") && !detail.includes("Falsches Passwort")) {
        await alertDlg(`Entpacken fehlgeschlagen: ${detail || r.status}`);
        return;
      }
      const pw = await promptDlg(
        detail.includes("Falsches Passwort")
          ? `Falsches Passwort für „${node.name}“ — erneut versuchen:`
          : `„${node.name}“ ist verschlüsselt — Passwort:`,
      );
      if (!pw) return;
      r = await post(pw);
    }
    if (!r.ok) {
      await alertDlg(`Entpacken fehlgeschlagen: ${(await r.json().catch(() => ({})))?.detail ?? r.status}`);
      return;
    }
    loadTree(activeSource, currentPath || "/");
  }, [activeSource, currentPath, loadTree, promptDlg, alertDlg]);

  return { archiveItem, encryptItem, extractItem };
}
