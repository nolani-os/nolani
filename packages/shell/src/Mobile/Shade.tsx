/**
 * Shade — the panel that comes down from the top (version 2).
 *
 * Layout modelled on Android 16 "Separate" / One UI 7: two panels instead of one.
 *   · `meldungen`  — swipe from top LEFT: large clock, groups "New" / "Silent",
 *                    cards with app circle, actions as pills, footer
 *                    settings · clear all · on to the toggles
 *   · `schnell`    — swipe from top RIGHT: the quick settings
 *   · `kombiniert` — the old form, both stacked (toggle in
 *                    QuickSettings -> "Shade layout")
 * A horizontal swipe in the open panel switches between the two — as on
 * current Android phones.
 *
 * Important: opaque background + blurred wallpaper behind it
 * (`--bg-window-solid`), NOT translucent cards: the rule "surfaces over
 * content are opaque" applies here as everywhere (NN/g on iOS 26: text on
 * transparency breaks down). Everything from tokens — light mode and accent
 * now arrive here too.
 *
 * The close gesture (swipe up, incl. native touch fallback because of
 * Android's `pointercancel`) stays in MobileShell; it gets panel and list via refs.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { motion } from "motion/react";
import { useUIStore, useWindowsStore } from "@claraos/core";
import type { Notification } from "@claraos/core";
import { primaryAction, runNotificationAction } from "../Notifications/notificationActions";
import { Icon } from "../components/Icon";
import { Button, IconButton } from "../components/Button";
import { QuickSettings } from "./QuickSettings";
import styles from "./Shade.module.css";

export type ShadeModus = "meldungen" | "schnell" | "kombiniert";

interface Gesten {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

interface Props {
  modus: ShadeModus;
  panelRef: RefObject<HTMLDivElement>;
  listRef: RefObject<HTMLDivElement>;
  gesten: Gesten;
  onWechsel: (ziel: "meldungen" | "schnell") => void;
  onSchliessen: () => void;
  onResetDock: () => void;
  vibrate: (ms?: number) => void;
}

const WECHSEL_SCHWELLE = 72; // px horizontal, well above the card swipe threshold

function Uhrzeit() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={styles.kopfUhr}>
      <div className={styles.uhr}>{now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</div>
      <div className={styles.datum}>{now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</div>
    </div>
  );
}

function Karte({ n, vibrate }: { n: Notification; vibrate: (ms?: number) => void }) {
  const removeNotification = useUIStore((s) => s.removeNotification);
  const [offen, setOffen] = useState(false);
  const zeit = new Date(n.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  // As on Android: tapping the card opens the target — the notification
  // stays. Deletion happens ONLY by swiping right. The target action therefore
  // gets no pill of its own; other actions (Yes/No, Later) remain as pills.
  const ziel = primaryAction(n);
  const pillen = (n.actions ?? []).filter((a) => a !== ziel);
  return (
    <motion.div
      className={`${styles.karte} ${n.read ? styles.karteGelesen : ""}`}
      data-notif-card
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.15, right: 0.6 }}
      onDragEnd={(_, info) => { if (info.offset.x > 120) { vibrate(); removeNotification(n.id); } }}
      onClick={() => {
        if (ziel) { vibrate(); runNotificationAction(n, ziel, { keepUnread: true }); return; }
        // Without a target: only expand. Here too NO "read" — otherwise the card
        // slides to "Silent" on tap and looks deleted.
        setOffen((o) => !o);
      }}
    >
      <span className={styles.kreis} aria-hidden="true">
        {n.icon ? <span className={styles.kreisZeichen}>{n.icon}</span> : <Icon name="bell" size={20} />}
      </span>
      <span className={styles.karteText}>
        <span className={styles.karteTitel}>{n.title}</span>
        <span className={`${styles.karteText2} ${offen ? styles.karteText2Offen : ""}`}>{n.body}</span>
        {pillen.length > 0 && (
          <span className={styles.aktionen}>
            {pillen.map((a, i) => (
              <Button
                key={`${a.id}-${a.label}`}
                groesse="s"
                stufe={i === 0 ? "tonal" : "text"}
                onClick={(e) => { e.stopPropagation(); vibrate(); runNotificationAction(n, a); }}
              >
                {a.label}
              </Button>
            ))}
          </span>
        )}
      </span>
      <span className={styles.karteRechts}>
        <span className={styles.zeit}>{zeit}</span>
        {!ziel && (
          <span className={`${styles.pfeil} ${offen ? styles.pfeilOffen : ""}`} aria-hidden="true"><Icon name="chevronDown" size={16} /></span>
        )}
      </span>
    </motion.div>
  );
}

export function Shade({ modus, panelRef, listRef, gesten, onWechsel, onSchliessen, onResetDock, vibrate }: Props) {
  const notifications = useUIStore((s) => s.notifications);
  const clearNotifications = useUIStore((s) => s.clearNotifications);
  const clearReadNotifications = useUIStore((s) => s.clearReadNotifications);
  const neu = notifications.filter((n) => !n.read).reverse();
  const still = notifications.filter((n) => n.read).reverse();
  const getrennt = modus !== "kombiniert";

  // A horizontal swipe switches the panel (separate mode only). Detected on
  // pointermove (an Android lesson), never in sliders or cards — there the
  // horizontal belongs to the slider or to swipe-to-dismiss.
  const wechsel = useRef<{ x: number; y: number; fired: boolean } | null>(null);
  const onDown = useCallback((e: ReactPointerEvent) => {
    gesten.onPointerDown(e);
    const t = e.target as HTMLElement;
    if (!getrennt || t.closest?.("[data-qs-control],[data-notif-card],button,input")) { wechsel.current = null; return; }
    wechsel.current = { x: e.clientX, y: e.clientY, fired: false };
  }, [gesten, getrennt]);
  const onMove = useCallback((e: ReactPointerEvent) => {
    gesten.onPointerMove(e);
    const s = wechsel.current;
    if (!s || s.fired) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) > WECHSEL_SCHWELLE && Math.abs(dx) > Math.abs(dy) * 1.3) {
      s.fired = true; vibrate();
      onWechsel(dx < 0 ? "schnell" : "meldungen");
    }
  }, [gesten, onWechsel, vibrate]);
  const onEnde = useCallback(() => { wechsel.current = null; gesten.onPointerUp(); }, [gesten]);
  const onAbbruch = useCallback(() => { wechsel.current = null; gesten.onPointerCancel(); }, [gesten]);

  const oeffneEinstellungen = useCallback(() => {
    useWindowsStore.getState().openWindow("settings");
    onSchliessen();
  }, [onSchliessen]);

  const zeigeMeldungen = modus !== "schnell";
  const zeigeSchnell = modus !== "meldungen";

  return (
    <motion.div
      key="shade"
      ref={panelRef}
      className={styles.panel}
      data-shade-modus={modus}
      initial={{ y: "-100%" }}
      animate={{ y: 0 }}
      exit={{ y: "-100%" }}
      transition={{ type: "spring", damping: 30, stiffness: 300 }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onEnde}
      onPointerCancel={onAbbruch}
    >
      <div className={styles.inhalt} ref={listRef}>
        {modus === "meldungen" && <Uhrzeit />}
        {zeigeSchnell && <QuickSettings onResetDock={onResetDock} />}

        {zeigeMeldungen && (
          <>
            {notifications.length === 0 ? (
              <div className={styles.leer}>
                <Icon name="bell" size={22} />
                <span>Keine Benachrichtigungen</span>
              </div>
            ) : (
              <>
                {neu.length > 0 && <div className={styles.gruppe}><span>Neu</span></div>}
                {neu.map((n) => <Karte key={n.id} n={n} vibrate={vibrate} />)}
                {still.length > 0 && (
                  <div className={styles.gruppe}>
                    <span>Still</span>
                    <IconButton label="Gelesene entfernen" icon="close" groesse="s" onClick={() => { vibrate(); clearReadNotifications(); }} />
                  </div>
                )}
                {still.map((n) => <Karte key={n.id} n={n} vibrate={vibrate} />)}
              </>
            )}
          </>
        )}
      </div>

      {zeigeMeldungen && (
        <div className={styles.fuss}>
          <IconButton label="Einstellungen" icon="gear" groesse="l" onClick={oeffneEinstellungen} />
          <Button stufe="tonal" groesse="l" className={styles.fussPille} disabled={notifications.length === 0}
                  onClick={() => { vibrate(); clearNotifications(); }}>
            Alle löschen
          </Button>
          {getrennt
            ? <IconButton label="Schnelleinstellungen" icon="arrowRight" groesse="l" onClick={() => onWechsel("schnell")} />
            : <IconButton label="Schließen" icon="close" groesse="l" onClick={onSchliessen} />}
        </div>
      )}

      {getrennt && (
        <div className={styles.seiten} aria-hidden="true">
          <button type="button" className={`${styles.punkt} ${modus === "meldungen" ? styles.punktAn : ""}`} onClick={() => onWechsel("meldungen")} tabIndex={-1} />
          <button type="button" className={`${styles.punkt} ${modus === "schnell" ? styles.punktAn : ""}`} onClick={() => onWechsel("schnell")} tabIndex={-1} />
        </div>
      )}
      <button type="button" className={styles.griff} onClick={onSchliessen} aria-label="Schließen">
        <span className={styles.griffLinie} />
      </button>
    </motion.div>
  );
}
