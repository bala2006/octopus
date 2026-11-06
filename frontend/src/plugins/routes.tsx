import * as React from "react";
import { Navigate, Route } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { DesktopLayout } from "@/components/layout/DesktopLayout";
import { routeRegistry, type RouteEntry } from "./registry";

function renderPage(entry: RouteEntry): React.ReactElement | undefined {
  if (!entry.component) return undefined;
  const Page = entry.component;
  return <Page {...entry.props} />;
}

function renderElement(entry: RouteEntry): React.ReactElement | undefined {
  if (entry.redirect !== undefined) {
    return <Navigate to={entry.redirect} replace />;
  }
  const wrapper = entry.wrapper;
  if (wrapper?.kind === "AppShell") {
    return <AppShell />;
  }
  const page = renderPage(entry);
  if (wrapper?.kind === "DesktopLayout") {
    return (
      <DesktopLayout
        header={
          <span className="text-[13px] font-medium">{wrapper.header}</span>
        }
      >
        {page}
      </DesktopLayout>
    );
  }
  return page;
}

/** Turns registry entries into React Router <Route> elements, in registry order. */
export function buildRoutes(
  entries: readonly RouteEntry[] = routeRegistry,
): React.ReactElement[] {
  return entries.map((entry) => {
    const element = renderElement(entry);
    if (entry.index) {
      return <Route key={entry.id} index element={element} />;
    }
    const nested = entry.children ? buildRoutes(entry.children) : undefined;
    return (
      <Route key={entry.id} path={entry.path} element={element}>
        {nested}
      </Route>
    );
  });
}
