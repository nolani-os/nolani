/**
 * In-chat camera viewfinder.
 *
 * Why this exists — and why the previous approach could not work:
 * The "Camera" entry in the attachment menu triggered a hidden
 * `<input type="file" accept="image/*" capture="environment">`. On the web
 * page that is exactly right — verified: the dialog opens with `capture`.
 * But the companion app does not honour it: `ShellActivity.onShowFileChooser`
 * builds the intent with `params.createIntent()`, which ignores `capture`; the
 * intended check `isCaptureEnabled()` is never used in the project. Result on
 * the phone: a file picker instead of the camera.
 *
 * This was already known and documented at the top of
 * `apps/kamera/sucher.ts` — the camera app is built around exactly this
 * knowledge ("in the INSTALLED app the viewfinder is the only way that
 * really opens the camera"). The chat had just never adopted it.
 *
 * So this reuses the same proven building block instead of a second path:
 * `getUserMedia` + `ImageCapture.takePhoto()` from `apps/kamera/sucher.ts`.
 * The system camera stays reachable as a fallback — for holiday photos the
 * device's computational photography is still better (as noted in `sucher.ts`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  sucherMoeglich, starteSucher, beendeSucher, ausloesen, leuchteMoeglich, leuchte,
} from "../apps/kamera/sucher";
import { useTranslation } from "@claraos/core";
import styles from "./KameraSheet.module.css";

export { sucherMoeglich };

export function KameraSheet({ onFoto, onAbbrechen, onSystemkamera }: {
  onFoto: (datei: File) => void;
  onAbbrechen: () => void;
  /** Fallback: the previous `<input capture>` path (browser, or when the viewfinder fails). */
  onSystemkamera: () => void;
}) {
  const { t } = useTranslation("chat");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [schiesst, setSchiesst] = useState(false);
  const [leuchteAn, setLeuchteAn] = useState(false);
  const [leuchteDa, setLeuchteDa] = useState(false);

  useEffect(() => {
    let abgebrochen = false;
    (async () => {
      try {
        const { stream } = await starteSucher();
        if (abgebrochen) { beendeSucher(stream); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setLeuchteDa(leuchteMoeglich(stream));
        setLaeuft(true);
      } catch (e) {
        setFehler(e instanceof Error ? e.message : t("camera.openFailed"));
      }
    })();
    return () => {
      abgebrochen = true;
      // Important: always stop the stream — otherwise the camera light stays on
      // even though the sheet was closed long ago. That is immediately visible
      // on the device, and nobody finds the cause.
      beendeSucher(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  const schiessen = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream || schiesst) return;
    setSchiesst(true);
    try {
      const blob = await ausloesen(stream, videoRef.current);
      const datei = new File([blob], `foto-${Date.now()}.jpg`,
        { type: blob.type || "image/jpeg" });
      onFoto(datei);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : t("camera.captureFailed"));
    } finally {
      setSchiesst(false);
    }
  }, [onFoto, schiesst, t]);

  const leuchteSchalten = useCallback(async () => {
    const neu = !leuchteAn;
    if (await leuchte(streamRef.current, neu)) setLeuchteAn(neu);
  }, [leuchteAn]);

  return (
    <div className={styles.blatt} role="dialog" aria-modal="true" aria-label={t("composer.takePhoto")}>
      <div className={styles.buehne}>
        <video
          ref={videoRef}
          className={styles.video}
          autoPlay
          muted
          playsInline
          data-testid="chat-sucher"
        />
        {!laeuft && (
          <div className={styles.hinweis}>
            {fehler ? (
              <>
                {fehler}
                <br />
                <button type="button" className={styles.ausweg} onClick={onSystemkamera}>
                  {t("camera.useSystemCamera")}
                </button>
              </>
            ) : t("camera.opening")}
          </div>
        )}
      </div>

      <div className={styles.leiste}>
        <button type="button" className={styles.neben} onClick={onAbbrechen}
                aria-label={t("camera.cancel")}>✕</button>
        <button
          type="button"
          className={styles.ausloeser}
          onClick={() => void schiessen()}
          disabled={!laeuft || schiesst}
          aria-label={t("composer.takePhoto")}
        />
        {leuchteDa ? (
          <button type="button" className={styles.neben} onClick={() => void leuchteSchalten()}
                  aria-pressed={leuchteAn} aria-label={t("camera.torch")}>
            {leuchteAn ? "🔦" : "💡"}
          </button>
        ) : (
          <button type="button" className={styles.neben} onClick={onSystemkamera}
                  aria-label={t("camera.systemCamera")}>📱</button>
        )}
      </div>
    </div>
  );
}
