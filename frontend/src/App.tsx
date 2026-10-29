import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/overlays";
import { ErrorBoundary } from "@/components/common";
import { AppShell } from "@/components/layout/AppShell";
import { DesktopLayout } from "@/components/layout/DesktopLayout";
import { WelcomePage } from "@/features/workspaces/WelcomePage";
import { useApp } from "@/stores/app";
import { useEditorStore } from "@/features/editor/editorStore";

const CanvasPage = React.lazy(() => import("@/features/canvas/CanvasPage"));
const ChatPage = React.lazy(() => import("@/features/chat/ChatPage"));
const RunsPage = React.lazy(() => import("@/features/runs/RunsPage"));
const LiveRunPage = React.lazy(() => import("@/features/runs/LiveRunPage"));
const ArtifactsPage = React.lazy(() => import("@/features/artifacts/ArtifactsPage"));
const SettingsPage = React.lazy(() => import("@/features/settings/SettingsPage"));
const GuidePage = React.lazy(() => import("@/features/guide/GuidePage"));
const WorkspacePage = React.lazy(() => import("@/features/editor/WorkspacePage"));
const AgentPage = React.lazy(() => import("@/features/editor/AgentPage"));

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy>
      <img src="/octopus.svg" alt="Loading" className="h-10 w-10 animate-pulse opacity-70" />
    </div>
  );
}

export function App() {
  const theme = useApp((s) => s.theme);
  React.useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (Object.values(useEditorStore.getState().projects).some((p) => p.tabs.some((t) => t.draft !== t.content))) {
        e.preventDefault(); e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  return (
    <TooltipProvider delayDuration={300}>
      <BrowserRouter>
        <ErrorBoundary>
          <React.Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<WelcomePage />} />
              <Route path="/settings" element={<DesktopLayout header={<span className="text-[13px] font-medium">Settings</span>}><SettingsPage /></DesktopLayout>} />
              <Route path="/w/:wid" element={<AppShell />}>
                <Route index element={<Navigate to="agent" replace />} />
                <Route path="agent" element={<AgentPage />} />
                <Route path="canvas" element={<CanvasPage />} />
                <Route path="workspace" element={<WorkspacePage />} />
                <Route path="chat" element={<ChatPage />} />
                <Route path="chat/:sessionId" element={<ChatPage />} />
                <Route path="runs" element={<RunsPage />} />
                <Route path="runs/:runId" element={<LiveRunPage />} />
                <Route path="artifacts" element={<ArtifactsPage />} />
                <Route path="artifacts/:runId" element={<ArtifactsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="guide" element={<GuidePage />} />
              </Route>
              <Route path="/guide" element={<DesktopLayout header={<span className="text-[13px] font-medium">Guide</span>}><GuidePage embedded /></DesktopLayout>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </React.Suspense>
        </ErrorBoundary>
      </BrowserRouter>
      <Toaster theme={theme} position="top-center" offset={56} closeButton toastOptions={{ className: "!rounded-lg !border-border" }} />
    </TooltipProvider>
  );
}
