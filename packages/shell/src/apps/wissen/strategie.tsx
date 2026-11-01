/** The Strategy section of the Knowledge app: visions, goals, KPI dashboard,
 * idea board and list, impact/effort matrix, idea graph.
 *
 * Registered with the core through `WissenSektion` instead of being imported
 * by it, so a build without this file (the standalone app) contains none of
 * these views — nor what they pull in (KPI charts, 5 Whys, Pareto, action plan).
 */
import { railItem, type WissenSektion } from "./erweiterung";
import { BoardView } from "../ideas/views/BoardView";
import { ListView } from "../ideas/views/ListView";
import { VisionsView } from "../ideas/views/VisionsView";
import { GoalsView } from "../ideas/views/GoalsView";
import { DashboardView } from "../ideas/views/DashboardView";
import { MatrixView } from "../ideas/views/MatrixView";
import { GraphView } from "../ideas/views/GraphView";

export const strategieSektion: WissenSektion = {
  bereich: "strategie",
  rails: [
    railItem("dash", "dashboard", "strategie"),
    railItem("goals", "target", "strategie"),
    railItem("visions", "horizon", "strategie"),
    railItem("board", "board", "strategie"),
    railItem("list", "list", "strategie"),
    railItem("matrix", "matrix", "strategie"),
    railItem("ideagraph", "graph", "strategie"),
  ],
  mobileTabs: ["dash", "goals", "board", "visions"],
  start: "dash",
  dashboard: "dash",
  pfade: { list: "list", board: "board", visions: "visions", goals: "goals", matrix: "matrix", dash: "dash" },
  render(rail, k) {
    switch (rail) {
      case "dash":
        return <DashboardView onOpen={k.onOpen} reloadTick={k.reloadTick} />;
      case "board":
        return <BoardView ideas={k.objects.filter((o) => o.type === "idea")}
                          currentUser={k.currentUser} onOpen={k.onOpen} onMove={k.onMoveStage} />;
      case "list":
        return <ListView ideas={k.objects.filter((o) => o.type === "idea" || o.type === "vision")}
                         currentUser={k.currentUser} onOpen={k.onOpen} />;
      case "goals":
        return <GoalsView currentUser={k.currentUser} onOpen={k.onOpen}
                          onChanged={k.reload} reloadTick={k.reloadTick} />;
      case "matrix":
        return <MatrixView currentUser={k.currentUser} onOpen={k.onOpen} reloadTick={k.reloadTick} />;
      case "visions":
        return <VisionsView objects={k.objects} currentUser={k.currentUser}
                            onOpen={k.onOpen} onChanged={k.reload} />;
      case "ideagraph":
        return <GraphView onOpen={k.onOpen} />;
      default:
        return null;
    }
  },
};
