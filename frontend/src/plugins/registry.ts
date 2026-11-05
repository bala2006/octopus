import * as React from "react";
import { WelcomePage } from "@/features/workspaces/WelcomePage";

/**
 * Frontend route registry (refactor plan, Phase 7).
 *
 * Lists every routed page in the order App.tsx used to render it. `buildRoutes` in
 * ./routes.tsx turns this list into the React Router tree. Changing an entry changes
 * the UI, so keep the list in sync with the screenshot baseline.
 */

/** Layers from the plan's Manifest type. Every page here is served by the Web shell, so each is "channel". */
export type PluginLayer =
  "channel" | "agent" | "workflow" | "capability" | "core";

/** Layout that wraps a route. AppShell renders its children through an Outlet. */
export type WrapperSpec =
  { kind: "AppShell" } | { kind: "DesktopLayout"; header: string };

// Any page component, eager or lazy.
type PageComponent = React.ComponentType<any>;

/**
 * Lazy page with the same dynamic import as before. React.lazy exposes no name until the
 * module loads, so the label goes on displayName. The route list test reads it.
 */
function lazyPage(
  name: string,
  load: () => Promise<{ default: PageComponent }>,
) {
  return Object.assign(React.lazy(load), { displayName: name });
}

// Declared in the same order as the original App.tsx. Changing this order renamed a shared
// production chunk (AgentPanel became PanelResize) during the Phase 7 build check.
const CanvasPage = lazyPage(
  "CanvasPage",
  () => import("@/features/canvas/CanvasPage"),
);
const ChatPage = lazyPage("ChatPage", () => import("@/features/chat/ChatPage"));
const RunsPage = lazyPage("RunsPage", () => import("@/features/runs/RunsPage"));
const ActivityPage = lazyPage(
  "ActivityPage",
  () => import("@/features/activity/ActivityPage"),
);
const LiveRunPage = lazyPage(
  "LiveRunPage",
  () => import("@/features/runs/LiveRunPage"),
);
const ArtifactsPage = lazyPage(
  "ArtifactsPage",
  () => import("@/features/artifacts/ArtifactsPage"),
);
const SettingsPage = lazyPage(
  "SettingsPage",
  () => import("@/features/settings/SettingsPage"),
);
const GuidePage = lazyPage(
  "GuidePage",
  () => import("@/features/guide/GuidePage"),
);
const WorkspacePage = lazyPage(
  "WorkspacePage",
  () => import("@/features/editor/WorkspacePage"),
);
const AgentPage = lazyPage(
  "AgentPage",
  () => import("@/features/editor/AgentPage"),
);

export interface RouteEntry {
  /** Unique among siblings. Used as the React key. */
  id: string;
  layer: PluginLayer;
  /** Absolute, or relative to the parent route. Omit for index routes. */
  path?: string;
  index?: boolean;
  /** Page rendered by this route. Omit for layout and redirect routes. */
  component?: PageComponent;
  /** Props passed to the page, for example `{ embedded: true }`. */
  props?: Record<string, unknown>;
  wrapper?: WrapperSpec;
  /** Renders `<Navigate to={redirect} replace />`. */
  redirect?: string;
  children?: readonly RouteEntry[];
}

export const routeRegistry: readonly RouteEntry[] = [
  { id: "welcome", layer: "channel", path: "/", component: WelcomePage },
  {
    id: "activity",
    layer: "channel",
    path: "/activity",
    wrapper: { kind: "DesktopLayout", header: "Activity" },
    component: ActivityPage,
  },
  {
    id: "settings",
    layer: "channel",
    path: "/settings",
    wrapper: { kind: "DesktopLayout", header: "Settings" },
    component: SettingsPage,
  },
  {
    id: "workspace-shell",
    layer: "channel",
    path: "/w/:wid",
    wrapper: { kind: "AppShell" },
    children: [
      {
        id: "workspace-index",
        layer: "channel",
        index: true,
        redirect: "agent",
      },
      { id: "agent", layer: "channel", path: "agent", component: AgentPage },
      { id: "canvas", layer: "channel", path: "canvas", component: CanvasPage },
      {
        id: "workspace",
        layer: "channel",
        path: "workspace",
        component: WorkspacePage,
      },
      { id: "chat", layer: "channel", path: "chat", component: ChatPage },
      {
        id: "chat-session",
        layer: "channel",
        path: "chat/:sessionId",
        component: ChatPage,
      },
      { id: "runs", layer: "channel", path: "runs", component: RunsPage },
      {
        id: "run-detail",
        layer: "channel",
        path: "runs/:runId",
        component: LiveRunPage,
      },
      {
        id: "artifacts",
        layer: "channel",
        path: "artifacts",
        component: ArtifactsPage,
      },
      {
        id: "artifact-detail",
        layer: "channel",
        path: "artifacts/:runId",
        component: ArtifactsPage,
      },
      {
        id: "workspace-settings",
        layer: "channel",
        path: "settings",
        component: SettingsPage,
      },
      {
        id: "workspace-guide",
        layer: "channel",
        path: "guide",
        component: GuidePage,
      },
    ],
  },
  {
    id: "guide",
    layer: "channel",
    path: "/guide",
    wrapper: { kind: "DesktopLayout", header: "Guide" },
    component: GuidePage,
    props: { embedded: true },
  },
  { id: "not-found", layer: "channel", path: "*", redirect: "/" },
];
