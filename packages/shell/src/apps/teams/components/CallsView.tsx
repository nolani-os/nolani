import { useEffect, useMemo, useRef, useState } from "react";
import { useMatrixStore } from "@claraos/core";
import { ClientWidgetApi, Widget } from "matrix-widget-api";
import {
  buildElementCallUrl,
  createAdHocRoom,
  endCall,
  getMatrixClient,
  getRoomWidgets,
  maybeCleanupAdHocRoom,
  startCall,
} from "../matrixClient";
import { ElementCallWidgetDriver } from "../elementCallDriver";
import styles from "./CallsView.module.css";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

export function CallsView() {
  const rooms = useMatrixStore((s) => s.rooms);

  const activeCallRooms = useMemo(
    () =>
      Object.values(rooms).filter(
        (r) => r.activeCall && r.membership === "join"
      ),
    [rooms]
  );

  const joinableRooms = useMemo(
    () =>
      Object.values(rooms)
        .filter((r) => !r.isSpace && r.membership === "join")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rooms]
  );

  const [mode, setMode] = useState<"list" | "in-call">("list");
  const [activeCallRoomId, setActiveCallRoomId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [callError, setCallError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const widgetApiRef = useRef<ClientWidgetApi | null>(null);

  // Keep dropdown selection valid as joinableRooms list changes
  useEffect(() => {
    if (joinableRooms.length === 0) {
      setSelectedRoomId("");
    } else if (!joinableRooms.some((r) => r.roomId === selectedRoomId)) {
      setSelectedRoomId(joinableRooms[0].roomId);
    }
  }, [joinableRooms, selectedRoomId]);

  // The call button in the channel header sets callToJoin and switches here —
  // join directly instead of forcing a detour through the list.
  const callToJoin = useMatrixStore((s) => s.callToJoin);
  const setCallToJoin = useMatrixStore((s) => s.setCallToJoin);
  useEffect(() => {
    if (callToJoin) {
      setCallToJoin(null);
      setActiveCallRoomId(callToJoin);
      setMode("in-call");
    }
  }, [callToJoin, setCallToJoin]);

  // Element Call embedding via Widget API. Auth is implicit — Element Call
  // proxies all Matrix RPCs to ElementCallWidgetDriver which uses the
  // already-authenticated client. The iframeKey lets the user retry if
  // Element Call doesn't signal "ready" within the timeout.
  useEffect(() => {
    if (mode !== "in-call" || !activeCallRoomId) return;
    const iframe = iframeRef.current;
    const client = getMatrixClient();
    if (!iframe || !client) return;

    setCallError(null);

    // Reuse the widgetId already in the room state (set by startCall) so all
    // participants converge on the same widget instance.
    const existing = getRoomWidgets(activeCallRoomId).find(
      (w) => w.type === "m.call"
    );
    const widgetId = existing?.id ?? `element-call-${activeCallRoomId}`;
    const url = buildElementCallUrl(activeCallRoomId, widgetId);

    iframe.src = url;
    const widget = new Widget({
      id: widgetId,
      type: "m.call",
      url,
      name: "Call",
      creatorUserId: client.getUserId() ?? "",
      data: {},
      // We set `iframe.src` ourselves above. With the default (true) the
      // widget API waits for its own load signal and rejects Element Call's
      // `contentLoaded` as "Improper sequence" (observed in the console).
      waitForIframeLoad: false,
    });
    const driver = new ElementCallWidgetDriver(activeCallRoomId);
    const api = new ClientWidgetApi(widget, iframe, driver);
    widgetApiRef.current = api;

    let stopped = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      readyTimer = null;
      setCallError("Call failed to load. Click Retry to try again.");
    }, 15000);

    const onReady = () => {
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
    };
    api.once("ready", onReady);

    // Important: Element Call 0.26 sends `io.element.close` on hang-up
    // (GroupCallView.tsx: `transport.send(ElementWidgetActions.Close)`), NOT
    // `io.element.hangup`. In this version `im.vector.hangup` only goes the
    // other way (host → widget). Without the close branch the Teams window
    // stayed in call state after the red button, with a dead iframe — and
    // `endCall()`/cleanup of ad-hoc rooms never ran.
    // The two old names stay in case a build drifts back.
    const hangup = () => handleLeave();
    api.on("action:io.element.close", hangup);
    api.on("action:io.element.hangup", hangup);
    api.on("action:im.vector.hangup", hangup);

    // Forward live Matrix events from the parent's matrix-js-sdk client into
    // the widget. Without this EC stays in "Loading..." after bootstrap
    // because new m.call.member events from other participants never reach it.
    const toIRoomEvent = (ev: any) => ({
      type: ev.getType(),
      sender: ev.getSender() ?? "",
      event_id: ev.getId() ?? "",
      room_id: ev.getRoomId() ?? "",
      state_key: ev.getStateKey(),
      origin_server_ts: ev.getTs(),
      content: ev.getContent() ?? {},
      unsigned: ev.getUnsigned() ?? {},
    });
    const isOurRoom = (rid: string | undefined | null) =>
      rid === activeCallRoomId;

    const onTimeline = (event: any, room: any) => {
      if (!isOurRoom(room?.roomId)) return;
      try {
        api.feedEvent(toIRoomEvent(event));
      } catch (e) {
        console.warn("[CallsView] feedEvent failed", e);
      }
    };
    const onStateEvent = (event: any) => {
      if (!isOurRoom(event.getRoomId())) return;
      // Important: do not forward state events WITHOUT a real ID.
      // For the local echo `getId()` is still empty; `toIRoomEvent` turned that
      // into `event_id: ""`. Element Call stores it as its own RTC membership —
      // and `useReactionsSender` checks with
      // `if (!myMembershipEvent) throw new Error("Cannot find own membership
      // event")`. That throw is NOT caught there (unlike raising a hand), hits
      // Element Call's error boundary and tears down the whole call — i.e. the
      // reaction button crashed the call.
      // The server sends the same event again shortly after, with an ID.
      if (!event.getId()) return;
      try {
        api.feedStateUpdate(toIRoomEvent(event));
      } catch (e) {
        console.warn("[CallsView] feedStateUpdate failed", e);
      }
    };
    const onToDevice = (event: any) => {
      try {
        api.feedToDevice(
          {
            type: event.getType(),
            sender: event.getSender() ?? "",
            content: event.getContent() ?? {},
          } as any,
          false
        );
      } catch (e) {
        console.warn("[CallsView] feedToDevice failed", e);
      }
    };

    // matrix-js-sdk constants — accessed via the live client's prototype to
    // avoid an extra import (RoomEvent.Timeline = "Room.timeline" string).
    client.on("Room.timeline" as any, onTimeline);
    client.on("RoomState.events" as any, onStateEvent);
    client.on("toDeviceEvent" as any, onToDevice);

    return () => {
      if (stopped) return;
      stopped = true;
      if (readyTimer) clearTimeout(readyTimer);
      // Unsubscribing only throws if the client is already gone — exactly the
      // state this cleanup aims for. Hence deliberately silent here.
      try { client.off("Room.timeline" as any, onTimeline); } catch { /* client already gone */ }
      try { client.off("RoomState.events" as any, onStateEvent); } catch { /* client already gone */ }
      try { client.off("toDeviceEvent" as any, onToDevice); } catch { /* client already gone */ }
      try {
        api.stop();
      } catch {
        /* idempotent */
      }
      widgetApiRef.current = null;
    };
    // handleLeave is stable enough (only reads activeCallRoomId via closure
    // captured at mount); excluding from deps avoids re-mounting the iframe
    // on every render and tearing down the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeCallRoomId, iframeKey]);

  const handleJoin = (roomId: string) => {
    setError(null);
    setActiveCallRoomId(roomId);
    setMode("in-call");
  };

  const handleStartIn = async () => {
    if (!selectedRoomId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startCall(selectedRoomId);
      setActiveCallRoomId(selectedRoomId);
      setMode("in-call");
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleInstantMeeting = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ts = new Date().toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const newRoomId = await createAdHocRoom(`Meeting ${ts}`);
      if (!newRoomId) throw new Error("Could not create meeting room");
      await startCall(newRoomId);
      setActiveCallRoomId(newRoomId);
      setMode("in-call");
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = async () => {
    const id = activeCallRoomId;
    setMode("list");
    setActiveCallRoomId(null);
    if (id) {
      // Idempotent; safe even if call already ended on remote side
      try {
        await endCall(id);
      } catch {
        /* noop */
      }
      // Instant-meeting rooms are single-purpose — drop them once we're the
      // last one out, so they don't linger in the sidebar forever.
      try {
        await maybeCleanupAdHocRoom(id);
      } catch {
        /* noop */
      }
    }
  };

  if (mode === "in-call" && activeCallRoomId) {
    const room = rooms[activeCallRoomId];
    return (
      <div className={styles.inCall} key={activeCallRoomId}>
        <div className={styles.inCallToolbar}>
          <span className={styles.inCallTitle}>
            <span className={styles.liveDot} />
            {room?.name ?? activeCallRoomId}
          </span>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={handleLeave}
          >
            Leave Call
          </button>
        </div>
        {callError && (
          <div
            className={styles.hint}
            style={{
              padding: "10px 16px",
              color: "#f38ba8",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--border-color, #313244)",
            }}
          >
            <span>{callError}</span>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                setCallError(null);
                setIframeKey((k) => k + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}
        <div className={styles.iframeWrap}>
          {/* Important (checked with `document.featurePolicy` INSIDE the frame):
              camera/microphone/display-capture were allowed — `fullscreen`
              and `screen-wake-lock` were NOT. Element Call needs both:
              fullscreen for the enlarged tile, wake lock so the screen does
              not turn off during a call. Without them the console shows
              "Permissions policy violation: screen-wake-lock is not allowed
              in this document". */}
          <iframe
            key={iframeKey}
            ref={iframeRef}
            title="Element Call"
            allowFullScreen
            className={styles.iframe}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="clipboard-write; clipboard-read; camera; microphone; display-capture; autoplay; fullscreen; screen-wake-lock"
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.callsView}>
      <div className={styles.header}>Anrufe</div>

      <div className={styles.section}>Laufende Anrufe</div>
      {activeCallRooms.length === 0 ? (
        <div className={styles.empty}>Gerade läuft kein Anruf</div>
      ) : (
        activeCallRooms.map((room) => (
          <div key={room.roomId} className={styles.callRow}>
            <div className={styles.avatar}>
              {room.avatarUrl ? (
                <img src={room.avatarUrl} alt="" />
              ) : (
                initials(room.name || "?")
              )}
            </div>
            <div className={styles.callMeta}>
              <span className={styles.roomName}>{room.name}</span>
              <span className={styles.subline}>
                <span className={styles.liveDot} />
                Live · {room.members.length} member
                {room.members.length === 1 ? "" : "s"}
              </span>
            </div>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => handleJoin(room.roomId)}
            >
              Join
            </button>
          </div>
        ))
      )}

      <div className={styles.newCallPanel}>
        <div className={styles.section} style={{ padding: 0 }}>
          Neuer Anruf
        </div>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleInstantMeeting}
          disabled={busy}
        >
          Sofortbesprechung starten
        </button>
        <div className={styles.hint}>
          Legt einen neuen privaten Raum an und startet dort einen Anruf.
        </div>

        <div className={styles.divider} />

        <div className={styles.hint}>Oder einen Anruf in einem vorhandenen Raum starten:</div>
        <div className={styles.row}>
          <select
            className={styles.select}
            value={selectedRoomId}
            onChange={(e) => setSelectedRoomId(e.target.value)}
            disabled={busy || joinableRooms.length === 0}
          >
            {joinableRooms.length === 0 ? (
              <option value="">Kein Raum verfügbar</option>
            ) : (
              joinableRooms.map((r) => (
                <option key={r.roomId} value={r.roomId}>
                  {r.name}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            className={styles.btn}
            onClick={handleStartIn}
            disabled={busy || !selectedRoomId}
          >
            Start
          </button>
        </div>

        {error && (
          <div className={styles.hint} style={{ color: "#f38ba8" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
