import * as React from "react";
import { BrowserRouter, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/overlays";
import { ErrorBoundary } from "@/components/common";
import { useApp } from "@/stores/app";
import { useEditorStore } from "@/features/editor/editorStore";
import { buildRoutes } from "@/plugins/routes";

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy>
      <img
        src="/octopus.svg"
        alt="Loading"
        className="h-10 w-10 animate-pulse opacity-70"
      />
    </div>
  );
}

export function App() {
  const theme = useApp((s) => s.theme);
  React.useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (
        Object.values(useEditorStore.getState().projects).some((p) =>
          p.tabs.some((t) => t.draft !== t.content),
        )
      ) {
        e.preventDefault();
        e.returnValue = "";
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
            <Routes>{buildRoutes()}</Routes>
          </React.Suspense>
        </ErrorBoundary>
      </BrowserRouter>
      <Toaster
        theme={theme}
        position="top-center"
        offset={56}
        closeButton
        toastOptions={{ className: "!rounded-lg !border-border" }}
      />
    </TooltipProvider>
  );
}
