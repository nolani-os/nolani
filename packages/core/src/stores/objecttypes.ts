import { create } from "zustand";
import type { ObjectType } from "../types";

// Built-in object types
const BUILTIN_TYPES: ObjectType[] = [
  {
    id: "folder", label: "Folder", icon: "📁", isComplex: false,
    defaultApp: "files", compatibleApps: ["files"],
    properties: [], actions: [
      { id: "open", label: "Open", icon: "📂", handler: "files" },
      { id: "rename", label: "Rename", icon: "✏️", handler: "system:rename" },
      { id: "delete", label: "Delete", icon: "🗑️", handler: "system:delete", requiresConfirm: true },
      { id: "props", label: "Properties", icon: "ℹ️", handler: "system:properties" },
    ],
    chatEnabled: false,
  },
  {
    id: "text-file", label: "Text File", icon: "📄", isComplex: false,
    defaultApp: "files", compatibleApps: ["files"],
    properties: [{ key: "encoding", label: "Encoding", type: "string", defaultValue: "utf-8" }],
    actions: [
      { id: "open", label: "Open", icon: "📄", handler: "files" },
      { id: "rename", label: "Rename", icon: "✏️", handler: "system:rename" },
      { id: "encrypt", label: "Encrypt with password", icon: "🔒", handler: "system:encrypt" },
      { id: "delete", label: "Delete", icon: "🗑️", handler: "system:delete", requiresConfirm: true },
      { id: "props", label: "Properties", icon: "ℹ️", handler: "system:properties" },
    ],
    chatEnabled: false,
  },
  {
    id: "image", label: "Image", icon: "🖼️", isComplex: false,
    defaultApp: "files", compatibleApps: ["files"],
    properties: [
      { key: "width", label: "Width", type: "number", unit: "px" },
      { key: "height", label: "Height", type: "number", unit: "px" },
    ],
    actions: [
      { id: "open", label: "View", icon: "🖼️", handler: "files" },
      { id: "rename", label: "Rename", icon: "✏️", handler: "system:rename" },
      { id: "delete", label: "Delete", icon: "🗑️", handler: "system:delete", requiresConfirm: true },
      { id: "props", label: "Properties", icon: "ℹ️", handler: "system:properties" },
    ],
    chatEnabled: false,
  },
];

export interface ObjectTypeStore {
  types: ObjectType[];
  getType: (id: string) => ObjectType | undefined;
  getTypeByExtension: (ext: string) => ObjectType | undefined;
  getDefaultApp: (typeId: string) => string | undefined;
  getCompatibleApps: (typeId: string) => string[];
}

const EXT_MAP: Record<string, string> = {
  txt: "text-file", md: "text-file", py: "text-file", ts: "text-file", js: "text-file",
  json: "text-file", yml: "text-file", yaml: "text-file", css: "text-file", html: "text-file",
  sh: "text-file", sql: "text-file", csv: "text-file",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image",
  pdf: "text-file",
};

export const useObjectTypeStore = create<ObjectTypeStore>()((_, get) => ({
  types: BUILTIN_TYPES,

  getType: (id) => get().types.find((t) => t.id === id),

  getTypeByExtension: (ext) => {
    const typeId = EXT_MAP[ext.toLowerCase()];
    return typeId ? get().types.find((t) => t.id === typeId) : undefined;
  },

  getDefaultApp: (typeId) => {
    const t = get().types.find((tp) => tp.id === typeId);
    return t?.defaultApp || t?.defaultWrapp;
  },

  getCompatibleApps: (typeId) => {
    const t = get().types.find((tp) => tp.id === typeId);
    return t?.compatibleApps || [];
  },
}));
