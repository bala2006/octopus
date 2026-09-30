import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/overlays";
import { ErrorBoundary } from "@/components/common";
import { AppShell } from "@/components/layout/AppShell";
import { WelcomePage } from "@/features/workspaces/WelcomePage";
import { useApp } from "@/stores/app";

const CanvasPage = React.lazy(() => import("@/features/canvas/CanvasPage"));
const ChatPage = React.lazy(() => import("@/features/chat/ChatPage"));
const RunsPage = React.lazy(() => import("@/features/runs/RunsPage"));
const LiveRunPage = React.lazy(() => import("@/features/runs/LiveRunPage"));
const ArtifactsPage = React.lazy(() => import("@/features/artifacts/ArtifactsPage"));
const SettingsPage = React.lazy(() => import("@/features/settings/SettingsPage"));
const GuidePage = React.lazy(() => import("@/features/guide/GuidePage"));

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy>
      <img src="/octopus.svg" alt="Loading" className="h-10 w-10 animate-pulse opacity-70" />
    </div>
  );
}

export function App() {
  const theme = useApp((s) => s.theme);
  return (
    <TooltipProvider delayDuration={300}>
      <BrowserRouter>
        <ErrorBoundary>
          <React.Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<WelcomePage />} />
              <Route path="/w/:wid" element={<AppShell />}>
                <Route index element={<Navigate to="canvas" replace />} />
                <Route path="canvas" element={<CanvasPage />} />
                <Route path="chat" element={<ChatPage />} />
                <Route path="chat/:sessionId" element={<ChatPage />} />
                <Route path="runs" element={<RunsPage />} />
                <Route path="runs/:runId" element={<LiveRunPage />} />
                <Route path="artifacts" element={<ArtifactsPage />} />
                <Route path="artifacts/:runId" element={<ArtifactsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="guide" element={<GuidePage />} />
              </Route>
              <Route path="/guide" element={<GuidePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </React.Suspense>
        </ErrorBoundary>
      </BrowserRouter>
      <Toaster theme={theme} position="top-center" offset={56} richColors closeButton toastOptions={{ className: "!rounded-lg !border-border" }} />
    </TooltipProvider>
  );
}
