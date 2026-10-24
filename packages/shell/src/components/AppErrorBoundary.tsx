/**
 * AppErrorBoundary — contains a crashing app INSIDE its window.
 *
 * Without this, a render error anywhere in an app pane unmounts the entire
  * React tree (the whole desktop goes black — e.g. a stale reference in
  * FileBrowser once killed the OS UI). Errors now render an in-window
 * error card with a reload action instead.
 */
import { Component, type ReactNode } from "react";
import { i18n } from "@claraos/core";

// Class component: no hooks, so texts are read from the shared instance at render.
const te = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(`components:errorBoundary.${key}`, opts);

interface Props {
  /** Window/app label for the error card. */
  appName?: string;
  /**
   * On phones there is no window bar with ✕ — without this button you would be
   * stuck on the error card. If set, a "close app" button appears.
   */
  onClose?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(`[AppErrorBoundary] ${this.props.appName ?? "app"} crashed:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            height: "100%",
            padding: 24,
            textAlign: "center",
            color: "var(--text-secondary, #9aa3b8)",
            fontSize: 13,
          }}
        >
          <span style={{ fontSize: 30 }} aria-hidden="true">⚠️</span>
          <strong style={{ color: "var(--text-primary, #e7e7eb)" }}>
            {te("crashed", { app: this.props.appName ?? te("thisApp") })}
          </strong>
          <code style={{ fontSize: 11, opacity: 0.7, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis" }}>
            {String(this.state.error.message ?? this.state.error).slice(0, 160)}
          </code>
          <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap", justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              style={{
                minHeight: 44,
                padding: "6px 16px",
                borderRadius: 8,
                border: "1px solid var(--border, rgba(255,255,255,0.14))",
                background: "transparent",
                color: "var(--text-primary, #e7e7eb)",
                cursor: "pointer",
              }}
            >
              {te("reload")}
            </button>
            {this.props.onClose && (
              <button
                type="button"
                onClick={this.props.onClose}
                style={{
                  minHeight: 44,
                  padding: "6px 16px",
                  borderRadius: 8,
                  border: "1px solid var(--border, rgba(255,255,255,0.14))",
                  background: "var(--accent, #7B9FFF)",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                {te("closeApp")}
              </button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
