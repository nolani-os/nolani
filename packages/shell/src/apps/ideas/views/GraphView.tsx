/** Ideen-Graph — Visionen + Ideen als Karte (@xyflow/react, schon Shell-Dep).
 * Layout statisch berechnet: Visionen als Spalten-Anker oben, ihre Ideen
 * (part_of_vision) darunter, Unzugeordnetes links. relates_to/inspired_by/
 * duplicates als gestrichelte Kanten. Klick auf Knoten → Detail. */
import { useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import styles from "../IdeasApp.module.css";
import { ideasApi } from "../api";
import type { KbObjectSlim } from "../types";
import { STAGE_BY_KEY } from "../stages";
import { useTranslation } from "@claraos/core";

interface GraphData {
  objects: KbObjectSlim[];
  links: { id: string; from_id: string; to_id: string; rel: string }[];
}

const NODE_W = 190;
const GAP_X = 230;
const GAP_Y = 92;

function buildFlow(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  const visions = data.objects.filter((o) => o.type === "vision");
  const ideas = data.objects.filter((o) => o.type === "idea");
  const visionOf = new Map<string, string>(); // idea-id → vision-id
  for (const l of data.links) {
    if (l.rel === "part_of_vision") visionOf.set(l.from_id, l.to_id);
  }

  const nodes: Node[] = [];
  const style = (o: KbObjectSlim, isVision: boolean) => ({
    width: NODE_W,
    borderRadius: 12,
    padding: "8px 10px",
    fontSize: 12,
    background: "var(--surface-2, #1f2430)",
    color: "var(--text-primary, #e5e7eb)",
    border: isVision
      ? "2px solid #f59e0b"
      : `1.5px solid ${STAGE_BY_KEY[o.stage ?? "spark"]?.color ?? "#3b82f6"}`,
  });
  const label = (o: KbObjectSlim, isVision: boolean) =>
    `${isVision ? "🌅" : STAGE_BY_KEY[o.stage ?? "spark"]?.icon ?? "💡"} ${o.title}`;

  // Spalte 0: unzugeordnete Ideen; danach eine Spalte pro Vision
  const unassigned = ideas.filter((i) => !visionOf.has(i.id));
  unassigned.forEach((o, i) => nodes.push({
    id: o.id, position: { x: 0, y: 80 + i * GAP_Y },
    data: { label: label(o, false) }, style: style(o, false),
  }));

  visions.forEach((v, vi) => {
    const x = (vi + 1) * GAP_X + 40;
    nodes.push({
      id: v.id, position: { x, y: 0 },
      data: { label: label(v, true) }, style: style(v, true),
    });
    ideas.filter((i) => visionOf.get(i.id) === v.id).forEach((o, i) => nodes.push({
      id: o.id, position: { x, y: 80 + i * GAP_Y },
      data: { label: label(o, false) }, style: style(o, false),
    }));
  });

  const known = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = data.links
    .filter((l) => known.has(l.from_id) && known.has(l.to_id))
    .map((l) => ({
      id: l.id,
      source: l.from_id,
      target: l.to_id,
      animated: l.rel === "part_of_vision",
      style: l.rel === "part_of_vision"
        ? { stroke: "#f59e0b" }
        : { stroke: "var(--text-tertiary, #6b7280)", strokeDasharray: "5 4" },
      label: l.rel === "part_of_vision" ? undefined
        : l.rel === "inspired_by" ? "inspiriert" : l.rel === "duplicates" ? "Duplikat" : undefined,
    }));

  return { nodes, edges };
}

export function GraphView({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation("wissen");
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ideasApi.getGraph()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);

  const flow = useMemo(() => (data ? buildFlow(data) : { nodes: [], edges: [] }), [data]);

  if (error) return <div className={styles.error}>{error}</div>;
  if (!data) return <div className={styles.empty}>{t("views.graph.loading")}</div>;
  if (flow.nodes.length === 0) {
    return <div className={styles.empty}>{t("views.graph.empty")}</div>;
  }

  return (
    <div className={styles.graphWrap}>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        onNodeClick={(_, node) => onOpen(node.id)}
        fitView
        minZoom={0.3}
        maxZoom={1.6}
        nodesDraggable
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
