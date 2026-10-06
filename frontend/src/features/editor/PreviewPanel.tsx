import * as React from "react";
import {
  ExternalLink,
  Globe,
  Monitor,
  RotateCw,
  Smartphone,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import { parsePreviewAddress } from "./previewAddress";

export function PreviewPanel({
  workspace,
  path,
  content,
  onClose,
  requestedAddress,
}: {
  workspace: string;
  path: string | null;
  content: string;
  onClose: () => void;
  requestedAddress?: { url: string };
}) {
  const [address, setAddress] = React.useState("");
  const [external, setExternal] = React.useState("");
  const [error, setError] = React.useState("");
  const [mobile, setMobile] = React.useState(false);
  const [version, setVersion] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (requestedAddress) {
      setAddress(requestedAddress.url);
      setExternal(requestedAddress.url);
    }
  }, [requestedAddress]);
  const previewable =
    path && /\.(html?|md|markdown|png|jpe?g|gif|webp|svg|pdf)$/i.test(path);
  const url =
    external ||
    (previewable
      ? `/api/v1/w/${workspace}/preview/${path.split("/").map(encodeURIComponent).join("/")}`
      : "");
  // Development servers have their own origin, so they can use storage and fetch
  // their APIs without gaining access to Octopus. Project-file previews stay opaque.
  const separateOrigin =
    !!external && new URL(external).origin !== window.location.origin;
  React.useEffect(() => {
    setLoading(true);
  }, [url, version]);
  return (
    <section
      aria-label="Browser preview"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <Globe className="mx-1 h-4 w-4 text-steel" />
        <span className="text-xs font-medium">Preview</span>
        <div className="ml-auto flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={mobile ? "Use desktop viewport" : "Use mobile viewport"}
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <Smartphone /> : <Monitor />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Refresh preview"
            onClick={() => setVersion((v) => v + 1)}
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
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      <form
        className="flex gap-2 border-b p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!address.trim()) {
            setExternal("");
            setError("");
            return;
          }
          try {
            setExternal(parsePreviewAddress(address));
            setError("");
          } catch {
            setError(
              "Enter an http:// or https:// address, such as localhost:3000.",
            );
          }
        }}
      >
        <Input
          aria-label="Preview address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="localhost:3000 or select an HTML file"
          className="h-8 min-w-0 text-xs"
        />
        <Button variant="secondary" size="sm" type="submit">
          Go
        </Button>
      </form>
      {external && (
        <button
          className="border-b px-3 py-1.5 text-left text-xs text-primary hover:bg-accent"
          onClick={() => {
            setExternal("");
            setAddress("");
          }}
        >
          Back to selected file
        </button>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
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
      ) : !external && path && /\.(md|markdown)$/i.test(path) ? (
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
            key={`${url}:${version}`}
            title="Project preview"
            src={url}
            onLoad={() => setLoading(false)}
            sandbox={`allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock${separateOrigin ? " allow-same-origin" : ""}`}
            className={cn(
              "h-full max-w-full rounded-lg border bg-white shadow-sm transition-[width] duration-200",
              mobile ? "w-[390px]" : "w-full",
            )}
          />
        </div>
      )}
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        {external
          ? "Some sites block embedded previews. Use Open in new tab if needed."
          : "HTML previews use saved files. Markdown previews include your edits."}
      </p>
    </section>
  );
}
