// react-rnd default configuration (adapted from daedalOS)
import type React from "react";

export const MIN_WINDOW_WIDTH = 200;
export const MIN_WINDOW_HEIGHT = 120;

export const TASKBAR_HEIGHT = 48;

export const RESIZE_HANDLE_STYLES: Record<string, React.CSSProperties> = {
  bottom: { bottom: "-3px", cursor: "ns-resize", height: "6px", left: 0, right: 0 },
  bottomLeft: { bottom: "-3px", cursor: "nesw-resize", height: "12px", left: "-3px", width: "12px" },
  bottomRight: { bottom: "-3px", cursor: "nwse-resize", height: "12px", right: "-3px", width: "12px" },
  left: { cursor: "ew-resize", left: "-3px", top: 0, bottom: 0, width: "6px" },
  right: { cursor: "ew-resize", right: "-3px", top: 0, bottom: 0, width: "6px" },
  top: { cursor: "ns-resize", height: "6px", left: 0, right: 0, top: "-3px" },
  topLeft: { cursor: "nwse-resize", height: "12px", left: "-3px", top: "-3px", width: "12px" },
  topRight: { cursor: "nesw-resize", height: "12px", right: "-3px", top: "-3px", width: "12px" },
};

export const RESIZING_ENABLED = {
  bottom: true,
  bottomLeft: true,
  bottomRight: true,
  left: true,
  right: true,
  top: true,
  topLeft: true,
  topRight: true,
};

export const RESIZING_DISABLED = {
  bottom: false,
  bottomLeft: false,
  bottomRight: false,
  left: false,
  right: false,
  top: false,
  topLeft: false,
  topRight: false,
};

export const RND_DEFAULTS = {
  cancel: ".cancel",
  dragHandleClassName: "window-drag-handle",
  enableUserSelectHack: false,
  minHeight: `${MIN_WINDOW_HEIGHT}px`,
  minWidth: `${MIN_WINDOW_WIDTH}px`,
  resizeHandleStyles: RESIZE_HANDLE_STYLES,
};
