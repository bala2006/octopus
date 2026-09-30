import * as React from "react";
import { applyNodeChanges, Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type NodeChange } from "@xyflow/react";
import { toEdge, toNode, type AgentNode, type ChannelEdge, type DeptMeta } from "@/stores/canvas";
import type { AgentOut, EdgeOut } from "@/types";
import { EditableContext, LiveContext, type LiveOverlay } from "@/features/canvas/live";
import { edgeTypes, nodeTypes } from "@/features/canvas/flowTypes";
import { DepartmentZones } from "@/features/canvas/DepartmentZones";
import { EdgeAnchorsProvider } from "@/features/canvas/edgeAnchors";

/** Read-only, animated company graph for live runs and replays. Agents hired mid-run pop in without resetting the layout. */
export function RunGraph(props: { agents: AgentOut[]; edges: EdgeOut[]; overlay: LiveOverlay; departments: Record<string, DeptMeta>; onSelect?: (agentId: string) => void }) {
  return <ReactFlowProvider><Graph {...props} /></ReactFlowProvider>;
}

function Graph({ agents, edges, overlay, departments, onSelect }: { agents: AgentOut[]; edges: EdgeOut[]; overlay: LiveOverlay; departments: Record<string, DeptMeta>; onSelect?: (agentId: string) => void }) {
  const [nodes, setNodes] = React.useState<AgentNode[]>(() => agents.map(toNode));
  const flowEdges = React.useMemo<ChannelEdge[]>(() => edges.map(toEdge), [edges]);
  const rf = useReactFlow();
  const count = React.useRef(agents.length);
  React.useEffect(() => {
    // Keep React Flow's per-node state (dragged position, measured size, selection) and only refresh the data.
    // Rebuilding nodes without `measured` makes React Flow hide them until they're re-measured.
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return agents.map((a) => {
        const n = toNode(a);
        const o = old.get(a.id);
        return o ? { ...o, data: n.data } : n;
      });
    });
    if (agents.length !== count.current) {
      const grew = agents.length > count.current;
      count.current = agents.length;
      if (grew) setTimeout(() => rf.fitView({ padding: 0.15, duration: 600 }), 80);
    }
  }, [agents, rf]);
  React.useEffect(() => { const t = setTimeout(() => rf.fitView({ padding: 0.15 }), 50); return () => clearTimeout(t); }, [rf]);
  return (
    <EditableContext.Provider value={false}>
      <LiveContext.Provider value={overlay}>
        <EdgeAnchorsProvider>
        <ReactFlow<AgentNode, ChannelEdge>
          nodes={nodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={(ch: NodeChange<AgentNode>[]) => setNodes((ns) => applyNodeChanges(ch.filter((c) => c.type !== "remove"), ns))}
          onNodeClick={(_, n) => onSelect?.(n.id)}
          nodesConnectable={false} edgesFocusable={false} connectionMode={ConnectionMode.Loose} deleteKeyCode={null}
          minZoom={0.15} maxZoom={1.6} proOptions={{ hideAttribution: true }} fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="hsl(var(--grid))" />
          <DepartmentZones departments={departments} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        </EdgeAnchorsProvider>
      </LiveContext.Provider>
    </EditableContext.Provider>
  );
}
