import { useEffect, useRef, useState } from "react";
import { useWindowsStore, buildObjectUri } from "@claraos/core";
import { FilePickerModal } from "../../Chat/FilePickerModal";
import { useIsMobile } from "../../Mobile/useIsMobile";
import { fileUrl } from "../../lib/downloadFile";
import { ladeGrund } from "../../lib/ladeGrund";
import { Icon } from "../../components/Icon";
// Same toolbar, same hints as the image viewer — both should feel like ONE
// viewer. That is why there is no separate stylesheet.
import css from "../image-viewer/ImageViewerApp.module.css";

export default function VideoPlayerApp({ windowId }: { windowId: string }) {
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [videoName, setVideoName] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  // "Loading" is tied to the VIDEO (until `loadeddata`), not to a separate
  // loading step before it — the file is streamed, so such a step would end
  // immediately and a "fetching the whole file" hint would be wrong.
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState("");
  const [waehlerOffen, setWaehlerOffen] = useState(false);
  const istHandy = useIsMobile();
  const setWindowFile = useWindowsStore((s) => s.setWindowFile);
  const closeWindow = useWindowsStore((s) => s.closeWindow);

  const winPath = useWindowsStore((s) => s.windows[windowId]?.path);
  const winSource = useWindowsStore((s) => s.windows[windowId]?.source);
  const winTitle = useWindowsStore((s) => s.windows[windowId]?.title);
  const setCurrentObjectUri = useWindowsStore((s) => s.setCurrentObjectUri);

  useEffect(() => {
    if (winPath && winSource) {
      setCurrentObjectUri(windowId, buildObjectUri("video-player", `${winSource}://${winPath}`));
    }
    return () => setCurrentObjectUri(windowId, undefined);
  }, [windowId, winPath, winSource, setCurrentObjectUri]);

  useEffect(() => {
    if (!winPath || !winSource) return;
    // Directly from the streaming endpoint (with Range = seeking) instead of
    // loading the whole file as Base64 — /read is capped at 10 MB.
    setFehler("");
    setLaedt(true);
    setVideoUrl(fileUrl(winSource, winPath, { inline: true }));
    setVideoName(winTitle || winPath.split("/").pop() || "Video");
  }, [winPath, winSource, winTitle]);

  const beiFehler = async () => {
    setLaedt(false);
    setFehler(await ladeGrund(videoUrl, "Video"));
  };

  return (
    <div className={css.wurzel}>
      <div className={css.leiste}>
        {istHandy && (
          <button onClick={() => closeWindow(windowId)} className={css.knopf}
            aria-label="Zurück zu den Dateien" title="Zurück">
            <Icon name="back" size={20} />
          </button>
        )}
        {/* Not a native <input type="file"> — on Android that launched Google
            Photos, i.e. outside ClaraOS. Instead ClaraOS's own file picker, the
            same on both platforms. */}
        <button onClick={() => setWaehlerOffen(true)} className={css.knopf}
          aria-label="Anderes Video öffnen" title="Anderes Video öffnen">
          <Icon name="folder" size={18} />{!istHandy && "Öffnen"}
        </button>
        {videoUrl && !fehler && (
          <>
            <button onClick={() => videoRef.current && (videoRef.current.currentTime = 0)}
              className={css.knopf} aria-label="Von vorn" title="Von vorn">
              <Icon name="restore" size={16} />{!istHandy && "Von vorn"}
            </button>
            <button onClick={() => {
              if (!videoRef.current) return;
              if (document.fullscreenElement) document.exitFullscreen();
              else videoRef.current.requestFullscreen();
            }} className={css.knopf} aria-label="Vollbild" title="Vollbild">
              <Icon name="fullscreen" size={16} />{!istHandy && "Vollbild"}
            </button>
          </>
        )}
        <span className={css.luecke} />
        {videoName && <span className={css.name} title={winPath}>{videoName}</span>}
      </div>

      <div className={css.flaeche}>
        {videoUrl && fehler ? (
          <div className={css.hinweis} role="alert">
            <Icon name="warning" size={40} className={css.fehlerSymbol} />
            <div className={css.hinweisTitel}>„{videoName}“ lässt sich nicht abspielen</div>
            <div className={css.hinweisText}>{fehler}</div>
            <button className={css.hauptknopf} onClick={() => setWaehlerOffen(true)}>
              Anderes Video öffnen
            </button>
          </div>
        ) : videoUrl ? (
          <>
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              autoPlay
              onLoadedData={() => setLaedt(false)}
              onError={beiFehler}
              style={{ maxWidth: "100%", maxHeight: "100%", outline: "none" }}
            />
            {laedt && (
              <div className={css.hinweis} style={{ position: "absolute", pointerEvents: "none" }}>
                <div className={css.kreisel} aria-label="Video wird geladen" />
              </div>
            )}
          </>
        ) : (
          <div className={css.hinweis}>
            <Icon name="play" size={48} />
            <div className={css.hinweisTitel}>Video öffnen, um es abzuspielen</div>
            <div className={css.hinweisText}>
              MP4, WebM und MOV laufen im Browser; MKV und AVI nur, wenn ihr Inhalt es zulässt
            </div>
            <button className={css.hauptknopf} onClick={() => setWaehlerOffen(true)}>
              Video auswählen
            </button>
          </div>
        )}
      </div>

      <FilePickerModal
        open={waehlerOffen}
        onClose={() => setWaehlerOffen(false)}
        mimePrefix="video/"
        onPickRefs={(refs) => {
          setWaehlerOffen(false);
          const r = refs[0];
          if (r) setWindowFile(windowId, r.source, r.path, r.name);
        }}
      />
    </div>
  );
}
