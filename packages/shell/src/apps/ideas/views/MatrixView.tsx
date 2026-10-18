/** Effort/impact matrix.
 *
 * Important: always filtered to EXACTLY ONE goal. The rating lives on the
 * idea→goal edge, not on the object: the same idea can look completely
 * different for another goal. A matrix "across everything" would show the same
 * points for every goal and would therefore be worthless.
 *
 * Important: plain SVG instead of a charting library — all apps share the shell
 * bundle, and a four-quadrant scatter plot is not worth a library.
 *
 * Warning: Clara's estimate is shown FADED with a dashed border until a human
 * confirms it. If you cannot tell a number from a guess, you lose trust in the
 * whole ranking. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "../IdeasApp.module.css";
import { ideasApi } from "../api";
import type { GoalNode, MatrixItem } from "../types";

interface Props {
  currentUser: string;
  onOpen: (id: string) => void;
  reloadTick: number;
}

const PAD = 34;          // room for the axis labels
const SIZE = 460;        // drawing area (square, scaled via viewBox)

/** 1..5 → pixels. Effort runs to the right, impact UPWARDS (SVG y is
 *  inverted — hence the subtraction). */
const xOf = (effort: number) => PAD + ((effort - 1) / 4) * (SIZE - 2 * PAD);
const yOf = (impact: number) => SIZE - PAD - ((impact - 1) / 4) * (SIZE - 2 * PAD);

function flatten(nodes: GoalNode[], out: GoalNode[] = []): GoalNode[] {
  nodes.forEach((n) => {
    if (n.type === "goal") out.push(n);
    flatten(n.children, out);
  });
  return out;
}

export function MatrixView({ currentUser, onOpen, reloadTick }: Props) {
  const [goals, setGoals] = useState<GoalNode[]>([]);
  const [goalId, setGoalId] = useState<string>("");
  const [items, setItems] = useState<MatrixItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await ideasApi.goalsTree();
        const flat = flatten(r.tree);
        setGoals(flat);
        setGoalId((cur) => cur || (flat[0]?.id ?? ""));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ziele nicht ladbar");
      } finally {
        setLoading(false);
      }
    })();
  }, [reloadTick]);

  const load = useCallback(async () => {
    if (!goalId) return;
    try {
      const r = await ideasApi.goalMatrix(goalId);
      setItems(r.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Matrix nicht ladbar");
    }
  }, [goalId]);

  useEffect(() => { void load(); }, [load, reloadTick]);

  /** Set a point's rating — this also counts as confirmation. */
  const rate = async (item: MatrixItem, effort: number, impact: number) => {
    setItems((prev) => prev.map((i) =>
      i.id === item.id ? { ...i, effort, impact, rated_by: currentUser, suggested: null } : i));
    try {
      await ideasApi.setContribution(goalId, item.id, impact, effort);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bewertung nicht gespeichert");
      await load();
    }
  };

  const posFromEvent = (e: React.MouseEvent | MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const rel = (v: number, min: number, span: number) => (v - min) / span;
    const px = rel(e.clientX - box.left, 0, box.width) * SIZE;
    const py = rel(e.clientY - box.top, 0, box.height) * SIZE;
    const clamp = (v: number) => Math.max(1, Math.min(5, Math.round(v)));
    return {
      effort: clamp(1 + ((px - PAD) / (SIZE - 2 * PAD)) * 4),
      impact: clamp(1 + ((SIZE - PAD - py) / (SIZE - 2 * PAD)) * 4),
    };
  };

  /** Unrated points are placed at Clara's suggestion — visibly faded, so
   *  "estimated" can be told apart from "confirmed". */
  const placed = useMemo(() => items.map((i) => {
    const effort = i.effort ?? i.suggested?.effort ?? null;
    const impact = i.impact ?? i.suggested?.impact ?? null;
    return { ...i, _effort: effort, _impact: impact, _guess: i.effort == null || i.impact == null };
  }), [items]);

  const unplaced = placed.filter((p) => p._effort === null || p._impact === null);
  const shown = placed.filter((p) => p._effort !== null && p._impact !== null);

  return (
    <div className={styles.matrixWrap}>
      <div className={styles.visionsHead}>
        <h3>🧭 Wirkung und Aufwand</h3>
        <select className={styles.input} value={goalId}
                onChange={(e) => setGoalId(e.target.value)} style={{ maxWidth: 320, margin: 0 }}>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>{"— ".repeat(g.depth)}{g.title}</option>
          ))}
        </select>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && <div className={styles.empty}>Lade…</div>}
      {!loading && goals.length === 0 && (
        <div className={styles.empty}>Noch kein Ziel — lege zuerst eins in der Ziele-Ansicht an.</div>
      )}

      {goalId && (
        <div className={styles.matrixBody}>
          <svg ref={svgRef} className={styles.matrix} viewBox={`0 0 ${SIZE} ${SIZE}`}
               onMouseMove={(e) => {
                 if (!drag) return;
                 const p = posFromEvent(e);
                 if (p) setItems((prev) => prev.map((i) =>
                   i.id === drag ? { ...i, effort: p.effort, impact: p.impact } : i));
               }}
               onMouseUp={(e) => {
                 if (!drag) return;
                 const p = posFromEvent(e);
                 const item = items.find((i) => i.id === drag);
                 setDrag(null);
                 if (p && item) void rate(item, p.effort, p.impact);
               }}
               onMouseLeave={() => setDrag(null)}>
            {/* Quadrants */}
            <rect x={PAD} y={PAD} width={(SIZE - 2 * PAD) / 2} height={(SIZE - 2 * PAD) / 2}
                  className={styles.qGood} />
            <rect x={SIZE / 2} y={PAD} width={(SIZE - 2 * PAD) / 2} height={(SIZE - 2 * PAD) / 2}
                  className={styles.qBig} />
            <rect x={PAD} y={SIZE / 2} width={(SIZE - 2 * PAD) / 2} height={(SIZE - 2 * PAD) / 2}
                  className={styles.qSmall} />
            <rect x={SIZE / 2} y={SIZE / 2} width={(SIZE - 2 * PAD) / 2} height={(SIZE - 2 * PAD) / 2}
                  className={styles.qBad} />

            <text x={PAD + 8} y={PAD + 18} className={styles.qLabel}>Schnelle Treffer</text>
            <text x={SIZE / 2 + 8} y={PAD + 18} className={styles.qLabel}>Große Brocken</text>
            <text x={PAD + 8} y={SIZE / 2 + 18} className={styles.qLabel}>Nebenbei</text>
            <text x={SIZE / 2 + 8} y={SIZE / 2 + 18} className={styles.qLabel}>Zeitfresser</text>

            {/* Axes */}
            <line x1={PAD} y1={SIZE - PAD} x2={SIZE - PAD} y2={SIZE - PAD} className={styles.axis} />
            <line x1={PAD} y1={PAD} x2={PAD} y2={SIZE - PAD} className={styles.axis} />
            <text x={SIZE - PAD} y={SIZE - 10} textAnchor="end" className={styles.axisLabel}>
              Aufwand →
            </text>
            <text x={10} y={PAD + 4} className={styles.axisLabel}>Wirkung ↑</text>

            {shown.map((p) => (
              <g key={p.id}
                 transform={`translate(${xOf(p._effort!)},${yOf(p._impact!)})`}
                 className={`${styles.point} ${p._guess ? styles.pointGuess : ""}`}
                 onMouseDown={() => setDrag(p.id)}
                 onDoubleClick={() => onOpen(p.id)}>
                <circle r={9} />
                <title>
                  {`${p.title}\nWirkung ${p._impact} · Aufwand ${p._effort}` +
                   (p._guess ? `\n(Claras Schätzung${p.suggested?.reason ? ": " + p.suggested.reason : ""} — zum Bestätigen ziehen)` : "")}
                </title>
                <text x={13} y={4} className={styles.pointLabel}>{p.title.slice(0, 26)}</text>
              </g>
            ))}
          </svg>

          <div className={styles.matrixSide}>
            <p className={styles.metaHint}>
              Punkt ziehen = bewerten und bestätigen · Doppelklick öffnet das Objekt.
              Blasse Punkte sind Claras Schätzung.
            </p>

            {unplaced.length > 0 && (
              <div className={styles.matrixUnplaced}>
                <strong>Noch unbewertet ({unplaced.length})</strong>
                <ul>
                  {unplaced.map((p) => (
                    <li key={p.id}>
                      <button className={styles.linkBtn} onClick={() => onOpen(p.id)}>{p.title}</button>
                      <button className={styles.btnGhost}
                              onClick={async () => {
                                try {
                                  await ideasApi.rateContribution(goalId, p.id);
                                  await load();
                                } catch (e) {
                                  setError(e instanceof Error ? e.message : "Schätzung fehlgeschlagen");
                                }
                              }}>Clara schätzen lassen</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {shown.length > 0 && (
              <div className={styles.matrixList}>
                <strong>Beste zuerst</strong>
                <ul>
                  {[...shown]
                    .sort((a, b) => (b._impact! - b._effort!) - (a._impact! - a._effort!))
                    .slice(0, 8)
                    .map((p) => (
                      <li key={p.id}>
                        <span className={styles.metaHint}>{p._impact}/{p._effort}</span>
                        <button className={styles.linkBtn} onClick={() => onOpen(p.id)}>
                          {p.title}
                        </button>
                        <button className={styles.btnGhost} title="Als Aufgabe in den Aktionsplan"
                                onClick={async () => {
                                  try {
                                    await ideasApi.promoteToPlan(goalId, p.id);
                                    await load();
                                  } catch (e) {
                                    setError(e instanceof Error ? e.message : "Übernahme fehlgeschlagen");
                                  }
                                }}>→ Aktionsplan</button>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {items.length === 0 && (
              <p className={styles.metaHint}>
                Diesem Ziel ist noch keine Idee zugeordnet. Lass dir in der Ziele-Ansicht
                welche von Clara vorschlagen.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
