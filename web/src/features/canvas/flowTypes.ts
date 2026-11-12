import type { EdgeTypes, NodeTypes } from "@xyflow/react";
import { AgentNode } from "./AgentNode";
import { ChannelEdge } from "./ChannelEdge";

export const nodeTypes: NodeTypes = { agent: AgentNode };
export const edgeTypes: EdgeTypes = { channel: ChannelEdge };
