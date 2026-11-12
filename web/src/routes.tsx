/** Every page of the app. Pages other than Home load on demand. */
import * as React from "react";
import { Navigate, Route } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { DesktopLayout } from "@/components/layout/DesktopLayout";
import { WelcomePage } from "@/features/projects/WelcomePage";

const AgentPage = React.lazy(() => import("@/features/conversation/AgentPage"));
const CanvasPage = React.lazy(() => import("@/features/canvas/CanvasPage"));
const WorkspacePage = React.lazy(() => import("@/features/code/WorkspacePage"));
const ChatPage = React.lazy(() => import("@/features/chat/ChatPage"));
const RunsPage = React.lazy(() => import("@/features/runs/RunsPage"));
const OpenRun = React.lazy(() => import("@/features/conversation/OpenRun"));
const ArtifactsPage = React.lazy(() => import("@/features/artifacts/ArtifactsPage"));
const SettingsPage = React.lazy(() => import("@/features/settings/SettingsPage"));
const GuidePage = React.lazy(() => import("@/features/guide/GuidePage"));
const ActivityPage = React.lazy(() => import("@/features/activity/ActivityPage"));

const desktop = (header: string, page: React.ReactNode) => (
  <DesktopLayout header={<span className="min-w-0 flex-1 truncate text-sm font-semibold">{header}</span>}>{page}</DesktopLayout>
);

export const routes = (
  <>
    <Route path="/" element={<WelcomePage />} />
    <Route path="/activity" element={desktop("Profile and activity", <ActivityPage />)} />
    <Route path="/settings" element={desktop("Settings", <SettingsPage />)} />
    <Route path="/guide" element={desktop("Guide", <GuidePage embedded />)} />
    <Route path="/w/:wid" element={<AppShell />}>
      <Route index element={<Navigate to="agent" replace />} />
      <Route path="agent" element={<AgentPage />} />
      <Route path="canvas" element={<CanvasPage />} />
      <Route path="workspace" element={<WorkspacePage />} />
      <Route path="chat" element={<ChatPage />} />
      <Route path="chat/:sessionId" element={<ChatPage />} />
      <Route path="runs" element={<RunsPage />} />
      <Route path="runs/:runId" element={<OpenRun />} />
      <Route path="artifacts" element={<ArtifactsPage />} />
      <Route path="artifacts/:runId" element={<ArtifactsPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="guide" element={<GuidePage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </>
);
