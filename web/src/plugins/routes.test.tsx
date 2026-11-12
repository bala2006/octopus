import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it } from "vitest";
import { buildRoutes } from "./routes";

type RouteProps = {
  path?: string;
  index?: boolean;
  element?: ReactElement;
  children?: ReactNode;
};

/** [full path, page component name, wrapper name]. */
type Row = readonly [string, string, string];

/** Element type name. Lazy pages carry their name in displayName (see lazyPage in registry.ts). */
function typeName(type: unknown): string {
  if (typeof type === "string") return type;
  const named = type as { displayName?: string; name?: string };
  return named.displayName ?? named.name ?? "anonymous";
}

function joinPath(parent: string | null, path = ""): string {
  if (parent === null || path.startsWith("/")) return path;
  return `${parent}/${path}`;
}

/**
 * One row per page, in render order. A layout route that only nests children (/w/:wid)
 * adds no row. Its name becomes the wrapper of those children.
 */
function flattenRoutes(
  nodes: ReactNode,
  parentPath: string | null = null,
  wrapper = "none",
): Row[] {
  const rows: Row[] = [];
  Children.forEach(nodes, (node) => {
    if (!isValidElement<RouteProps>(node)) return;
    const { path, index, element, children } = node.props;
    const fullPath = index
      ? `${parentPath} (index)`
      : joinPath(parentPath, path);
    if (children !== undefined) {
      rows.push(
        ...flattenRoutes(
          children,
          fullPath,
          element ? typeName(element.type) : wrapper,
        ),
      );
      return;
    }
    let page = element;
    let pageWrapper = wrapper;
    if (element && typeName(element.type) === "DesktopLayout") {
      pageWrapper = "DesktopLayout";
      page = element.props.children;
    }
    rows.push([fullPath, page ? typeName(page.type) : "none", pageWrapper]);
  });
  return rows;
}

/**
 * Expected rows, written by hand from the original App.tsx before the registry existed.
 * Order and paths are the original order.
 */
const EXPECTED_ROUTES: Row[] = [
  ["/", "WelcomePage", "none"],
  ["/activity", "ActivityPage", "DesktopLayout"],
  ["/settings", "SettingsPage", "DesktopLayout"],
  ["/w/:wid (index)", "Navigate", "AppShell"],
  ["/w/:wid/agent", "AgentPage", "AppShell"],
  ["/w/:wid/canvas", "CanvasPage", "AppShell"],
  ["/w/:wid/workspace", "WorkspacePage", "AppShell"],
  ["/w/:wid/chat", "ChatPage", "AppShell"],
  ["/w/:wid/chat/:sessionId", "ChatPage", "AppShell"],
  ["/w/:wid/runs", "RunsPage", "AppShell"],
  ["/w/:wid/runs/:runId", "LiveRunPage", "AppShell"],
  ["/w/:wid/artifacts", "ArtifactsPage", "AppShell"],
  ["/w/:wid/artifacts/:runId", "ArtifactsPage", "AppShell"],
  ["/w/:wid/settings", "SettingsPage", "AppShell"],
  ["/w/:wid/guide", "GuidePage", "AppShell"],
  ["/guide", "GuidePage", "DesktopLayout"],
  ["*", "Navigate", "none"],
];

function findRoute(
  nodes: ReactElement[],
  path: string,
): ReactElement<RouteProps> {
  const found = nodes.find((node) => (node.props as RouteProps).path === path);
  if (!found) throw new Error(`no route with path ${path}`);
  return found;
}

describe("route registry", () => {
  it("matches the original App.tsx: paths, page components, wrappers, header labels, redirects and guide props", () => {
    const routes = buildRoutes();
    expect(flattenRoutes(routes)).toEqual(EXPECTED_ROUTES);

    const headerText = (path: string) =>
      (findRoute(routes, path).props.element?.props as { header: ReactElement })
        .header.props.children;

    expect(headerText("/activity")).toBe("Activity");
    expect(headerText("/settings")).toBe("Settings");
    expect(headerText("/guide")).toBe("Guide");

    const shell = findRoute(routes, "/w/:wid");
    expect(typeName(shell.props.element?.type)).toBe("AppShell");
    const shellChildren = shell.props.children as ReactElement<RouteProps>[];
    const index = shellChildren.find((child) => child.props.index);
    expect(index?.props.element?.props).toEqual({ to: "agent", replace: true });

    expect(
      findRoute(routes, "/guide").props.element?.props.children.props,
    ).toEqual({ embedded: true });
    expect(findRoute(routes, "*").props.element?.props).toEqual({
      to: "/",
      replace: true,
    });
  });
});
