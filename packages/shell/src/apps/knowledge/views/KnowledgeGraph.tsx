/** Knowledge graph of the Knowledge Suite.
 * Nodes = visible objects, edges = kb_refs (mentions + relations), which the
 * post-save pipeline maintains automatically. The server only returns edges
 * when BOTH ends are visible. */
import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import styles from "../../ideas/IdeasApp.module.css";
import { ideasApi } from "../../ideas/api";

interface Props {
  onOpen: (id: string) => void;
}

export function KnowledgeGraph({ onOpen }: Props) {
  const [data, setData] = useState<{
    nodes: { id: string; title: string; type: string; icon: string | null }[];
    edges: { from: string; to: string; kind: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ideasApi.knowledgeGraph()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    // Linked objects first — they carry the structure of the graph
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const sorted = [...data.nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
    const cols = Math.ceil(Math.sqrt(sorted.length || 1));
    const nodes: Node[] = sorted.map((n, i) => ({
      id: n.id,
      position: { x: (i % cols) * 210, y: Math.floor(i / cols) * 110 },
      // The graph draws plain text nodes — there is no SVG icon here.
      // Instead of an emoji (which looks different per device) only the title is shown.
      data: { label: `${n.title.length > 26 ? n.title.slice(0, 25) + "…" : n.title}` },
      style: {
        fontSize: 12, padding: 6, borderRadius: 8,
        border: (degree.get(n.id) ?? 0) > 0 ? "2px solid #6366f1" : "1px solid #6b7280",
        background: "rgba(120,120,140,.14)", color: "inherit", width: 190,
      },
    }));
    const edges: Edge[] = data.edges.map((e, i) => ({
      id: `e${i}`, source: e.from, target: e.to,
      animated: e.kind === "relation_prop",
      style: { stroke: e.kind === "relation_prop" ? "#818cf8" : "#6b7280" },
    }));
    return { nodes, edges };
  }, [data]);

  if (error) return <div className={styles.error}>{error}</div>;
  if (!data) return <div className={styles.empty}>Lade Netz…</div>;
  if (!data.nodes.length) {
    return <div className={styles.empty}>Noch keine Objekte im Netz.</div>;
  }

  return (
    <div className={styles.graphWrap}>
      <div className={styles.metaHint}>
        {data.nodes.length} Objekte · {data.edges.length} Verbindungen
        {data.edges.length === 0 && " — verlinke Objekte mit @-Erwähnungen oder Verknüpfungs-Feldern"}
      </div>
      <div style={{ flex: 1, minHeight: 320 }}>
        <ReactFlow nodes={nodes} edges={edges} fitView
                   onNodeClick={(_, n) => onOpen(n.id)}
                   proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
