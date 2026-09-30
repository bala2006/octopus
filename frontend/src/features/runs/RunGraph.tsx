import * as React from "react";
import { Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { toEdge, toNode, type AgentNode, type ChannelEdge, type DeptMeta } from "@/stores/canvas";
import type { AgentOut, EdgeOut } from "@/types";
import { EditableContext, LiveContext, type LiveOverlay } from "@/features/canvas/live";
import { edgeTypes, nodeTypes } from "@/features/canvas/flowTypes";
import { DepartmentZones } from "@/features/canvas/DepartmentZones";

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
    setNodes((prev) => {
      const pos = new Map(prev.map((n) => [n.id, n.position]));
      return agents.map((a) => { const n = toNode(a); const p = pos.get(a.id); return p ? { ...n, position: p } : n; });
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
        <ReactFlow<AgentNode, ChannelEdge>
          nodes={nodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={(ch) => setNodes((ns) => ns.map((n) => { const c = ch.find((x) => "id" in x && x.id === n.id && x.type === "position"); return c && c.type === "position" && c.position ? { ...n, position: c.position } : n; }))}
          onNodeClick={(_, n) => onSelect?.(n.id)}
          nodesConnectable={false} edgesFocusable={false} connectionMode={ConnectionMode.Loose} deleteKeyCode={null}
          minZoom={0.15} maxZoom={1.6} proOptions={{ hideAttribution: true }} fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="hsl(var(--grid))" />
          <DepartmentZones departments={departments} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </LiveContext.Provider>
    </EditableContext.Provider>
  );
}
