import * as React from "react";
import { Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { toEdge, toNode, type AgentNode, type ChannelEdge } from "@/stores/canvas";
import type { AgentOut, EdgeOut } from "@/types";
import { EditableContext, LiveContext, type LiveOverlay } from "@/features/canvas/live";
import { edgeTypes, nodeTypes } from "@/features/canvas/flowTypes";

/** Read-only, animated company graph for live runs and replays (built from the run's frozen snapshot). */
export function RunGraph(props: { agents: AgentOut[]; edges: EdgeOut[]; overlay: LiveOverlay; onSelect?: (agentId: string) => void }) {
  return <ReactFlowProvider><Graph {...props} /></ReactFlowProvider>;
}

function Graph({ agents, edges, overlay, onSelect }: { agents: AgentOut[]; edges: EdgeOut[]; overlay: LiveOverlay; onSelect?: (agentId: string) => void }) {
  const [nodes, setNodes] = React.useState<AgentNode[]>(() => agents.map(toNode));
  const flowEdges = React.useMemo<ChannelEdge[]>(() => edges.map(toEdge), [edges]);
  const rf = useReactFlow();
  React.useEffect(() => { setNodes(agents.map(toNode)); }, [agents]);
  React.useEffect(() => { const t = setTimeout(() => rf.fitView({ padding: 0.15 }), 50); return () => clearTimeout(t); }, [rf, agents.length]);
  return (
    <EditableContext.Provider value={false}>
      <LiveContext.Provider value={overlay}>
        <ReactFlow<AgentNode, ChannelEdge>
          nodes={nodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={(ch) => setNodes((ns) => ns.map((n) => { const c = ch.find((x) => "id" in x && x.id === n.id && x.type === "position"); return c && c.type === "position" && c.position ? { ...n, position: c.position } : n; }))}
          onNodeClick={(_, n) => onSelect?.(n.id)}
          nodesConnectable={false} edgesFocusable={false} connectionMode={ConnectionMode.Loose} deleteKeyCode={null}
          minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: true }} fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="hsl(var(--grid))" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </LiveContext.Provider>
    </EditableContext.Provider>
  );
}
