/**
 * downloadFile — download files and folders (Files app, desktop menus).
 *
 * Note: an earlier version fetched content as JSON/Base64 via /read and assembled
 * a Blob in the browser — a 10 MB limit, the whole file twice in memory, no
 * folders, and errors failed SILENTLY (`return false`). Now the browser loads
 * directly from the streaming endpoint; folders and multiple entries arrive as
 * a ZIP. The browser shows progress itself.
 */
const API = "/api/claraos/files/v2";

/** URL for loading a file directly (inline = display instead of save). */
export function fileUrl(source: string, path: string, opts: { inline?: boolean } = {}): string {
  const q = new URLSearchParams({ source, path });
  if (opts.inline) q.set("inline", "1");
  return `${API}/download?${q.toString()}`;
}

/** Download via an invisible link — the browser handles progress and saving. */
function trigger(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Download one file (or a folder → ZIP). */
export async function downloadFile(source: string, path: string, _name?: string): Promise<boolean> {
  trigger(fileUrl(source, path));
  return true;
}

/** Download several entries as ONE ZIP. */
export function downloadMany(source: string, paths: string[], zipName?: string): void {
  if (paths.length === 1) { trigger(fileUrl(source, paths[0])); return; }
  const q = new URLSearchParams({ source });
  for (const p of paths) q.append("path", p);
  if (zipName) q.set("name", zipName);
  trigger(`${API}/download?${q.toString()}`);
}
