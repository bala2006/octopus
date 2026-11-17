import {
  ExternalLink,
  Globe,
  Monitor,
  RotateCw,
  Smartphone,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import { parsePreviewAddress } from "./previewAddress";

const PREVIEWABLE = /\.(html?|md|markdown|png|jpe?g|gif|webp|svg|pdf)$/i;

/** The preview's state. The editor header and the preview body both read it, and it belongs to one editor tab. */
export type PreviewState = {
  key: string;
  address: string;
  external: string;
  mobile: boolean;
  reload: number;
  error: string;
  /** The frame that finished loading, as `${url}:${reload}`. */
  loaded: string | null;
};

export function emptyPreview(key: string): PreviewState {
  return {
    key,
    address: "",
    external: "",
    mobile: false,
    reload: 0,
    error: "",
    loaded: null,
  };
}

/** The address the frame shows: a typed development-server address, or the selected project file. */
export function previewUrl(
  workspace: string,
  path: string | null,
  external: string,
): string {
  if (external) return external;
  if (!path || !PREVIEWABLE.test(path)) return "";
  return `/api/v1/w/${workspace}/preview/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The address field and the frame controls. They sit in the editor's header row while the preview is on. */
export function PreviewControls({
  state,
  url,
  onChange,
}: {
  state: PreviewState;
  url: string;
  onChange: (patch: Partial<PreviewState>) => void;
}) {
  return (
    <>
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!state.address.trim()) {
            onChange({ external: "", error: "" });
            return;
          }
          try {
            onChange({ external: parsePreviewAddress(state.address), error: "" });
          } catch {
            onChange({
              error:
                "Enter an http:// or https:// address, such as localhost:3000.",
            });
          }
        }}
      >
        <Input
          aria-label="Preview address"
          value={state.address}
          onChange={(e) => onChange({ address: e.target.value })}
          placeholder="localhost:3000 or select an HTML file"
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Button variant="secondary" size="sm" type="submit">
          Go
        </Button>
        {state.external && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ external: "", address: "", error: "" })}
          >
            <Undo2 />
            Back to file
          </Button>
        )}
      </form>
      <Button
        size="icon"
        variant="ghost"
        aria-label={state.mobile ? "Use desktop viewport" : "Use mobile viewport"}
        onClick={() => onChange({ mobile: !state.mobile })}
      >
        {state.mobile ? <Smartphone /> : <Monitor />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Refresh preview"
        onClick={() => onChange({ reload: state.reload + 1 })}
      >
        <RotateCw />
      </Button>
      {url && (
        <Button size="icon" variant="ghost" asChild>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open preview in new tab"
          >
            <ExternalLink />
          </a>
        </Button>
      )}
    </>
  );
}

/** The preview page: the frame, a Markdown render, or the empty state. */
export function PreviewBody({
  state,
  url,
  path,
  content,
  onChange,
}: {
  state: PreviewState;
  url: string;
  path: string | null;
  content: string;
  onChange: (patch: Partial<PreviewState>) => void;
}) {
  const frame = `${url}:${state.reload}`;
  const loading = !!url && state.loaded !== frame;
  // Development servers have their own origin, so they can use storage and fetch
  // their APIs without gaining access to Octopus. Project-file previews stay opaque.
  const separateOrigin =
    !!state.external && new URL(state.external).origin !== window.location.origin;
  return (
    <section
      aria-label="Browser preview"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
    >
      {state.error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {state.error}
        </p>
      )}
      {!url ? (
        <div className="m-auto max-w-xs p-6 text-center">
          <Globe className="mx-auto mb-3 h-8 w-8 text-steel" />
          <h2 className="text-sm font-semibold">See what you’re building</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Select an HTML, Markdown, image, or PDF file. For a running app,
            enter its development server address above.
          </p>
        </div>
      ) : !state.external && path && /\.(md|markdown)$/i.test(path) ? (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <Markdown>{content}</Markdown>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 justify-center overflow-hidden p-2">
          {loading && (
            <div
              role="status"
              className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-background px-3 py-1 text-xs shadow"
            >
              Loading preview…
            </div>
          )}
          <iframe
            key={frame}
            title="Project preview"
            src={url}
            onLoad={() => onChange({ loaded: frame })}
            sandbox={`allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock${separateOrigin ? " allow-same-origin" : ""}`}
            className={cn(
              "h-full max-w-full rounded-lg border bg-white shadow-sm transition-[width] duration-200",
              state.mobile ? "w-[390px]" : "w-full",
            )}
          />
        </div>
      )}
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        {state.external
          ? "Some sites block embedded previews. Use Open in new tab if needed."
          : "HTML previews use saved files. Markdown previews include your edits."}
      </p>
    </section>
  );
}
