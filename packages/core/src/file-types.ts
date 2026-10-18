/**
 * file-types — single source of truth for "which ClaraOS viewer app should
 * open this file?". Mirrored on the backend by `claraos_action_mcp_server.py:
 * EXT_TO_VIEWER` so frontend and Clara agree.
 */

const EXT_TO_VIEWER: Record<string, string> = {
  // images
  ".png": "image-viewer",
  ".jpg": "image-viewer",
  ".jpeg": "image-viewer",
  ".gif": "image-viewer",
  ".webp": "image-viewer",
  ".bmp": "image-viewer",
  ".svg": "image-viewer",
  ".tiff": "image-viewer",
  ".tif": "image-viewer",
  // documents
  ".pdf": "pdf-viewer",
  // office → Collabora (Nextcloud /f/<fileId>); Backend-Mirror
  // claraos_action_mcp_server.py:EXT_TO_VIEWER bei Gelegenheit nachziehen.
  ".doc": "office-viewer",
  ".docx": "office-viewer",
  ".odt": "office-viewer",
  ".xls": "office-viewer",
  ".xlsx": "office-viewer",
  ".ods": "office-viewer",
  ".ppt": "office-viewer",
  ".pptx": "office-viewer",
  ".odp": "office-viewer",
  // 3d
  ".stl": "model-viewer",
  ".obj": "model-viewer",
  ".ply": "model-viewer",
  ".glb": "model-viewer",
  ".gltf": "model-viewer",
  // video
  ".mp4": "video-player",
  ".mov": "video-player",
  ".webm": "video-player",
  ".mkv": "video-player",
  ".avi": "video-player",
  ".m4v": "video-player",
  // text + code (text-editor)
  ".txt": "text-editor",
  ".md": "text-editor",
  ".rst": "text-editor",
  ".json": "text-editor",
  ".jsonc": "text-editor",
  ".yaml": "text-editor",
  ".yml": "text-editor",
  ".toml": "text-editor",
  ".ini": "text-editor",
  ".cfg": "text-editor",
  ".conf": "text-editor",
  ".env": "text-editor",
  ".py": "text-editor",
  ".js": "text-editor",
  ".jsx": "text-editor",
  ".ts": "text-editor",
  ".tsx": "text-editor",
  ".css": "text-editor",
  ".scss": "text-editor",
  ".html": "text-editor",
  ".xml": "text-editor",
  ".sh": "text-editor",
  ".bash": "text-editor",
  ".zsh": "text-editor",
  ".sql": "text-editor",
  ".go": "text-editor",
  ".rs": "text-editor",
  ".rb": "text-editor",
  ".php": "text-editor",
  ".java": "text-editor",
  ".kt": "text-editor",
  ".swift": "text-editor",
  ".c": "text-editor",
  ".h": "text-editor",
  ".cpp": "text-editor",
  ".hpp": "text-editor",
  ".cs": "text-editor",
  ".lua": "text-editor",
  ".vim": "text-editor",
  ".dockerfile": "text-editor",
  ".gitignore": "text-editor",
  ".log": "text-editor",
};

/**
 * Pick the right ClaraOS viewer for a given file path. Falls back to the
 * Files-app (with the parent dir loaded) if the extension isn't known.
 */
export function inferViewerForPath(path: string, hint?: string): string {
  if (hint) return hint;
  if (!path) return "text-editor";
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "files";
  const ext = lower.slice(dot);
  return EXT_TO_VIEWER[ext] ?? "files";
}

/** Quick yes/no check whether a path opens in image-viewer. */
export function isImagePath(path: string): boolean {
  return inferViewerForPath(path) === "image-viewer";
}

/** Quick yes/no check whether a path opens in text-editor. */
export function isTextPath(path: string): boolean {
  return inferViewerForPath(path) === "text-editor";
}
