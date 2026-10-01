import * as React from "react";
import { toast } from "sonner";
import { FileText, X } from "lucide-react";
import { fetchRaw } from "@/lib/api";
import type { ParsedFileOut } from "@/types";

const TEXT_ACCEPT = ".txt,.md,.markdown,.pdf,.py,.js,.ts,.tsx,.jsx,.json,.yaml,.yml,.toml,.html,.css,.java,.go,.rs,.c,.cpp,.h,.rb,.php,.sh,.sql,.csv,.xml";
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp";
export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGES = 4;

export const isImage = (f: ParsedFileOut) => f.kind === "image";
export const imageSrc = (f: ParsedFileOut) => `data:${f.mime || "image/png"};base64,${f.data}`;

/** What a run / message sends for its attachments: text files as text, images as base64 (shown to the agents as images). */
export function attachmentPayload(files: ParsedFileOut[]): Record<string, string>[] {
  return files.map((f): Record<string, string> => (isImage(f) ? { filename: f.filename, kind: "image", mime: f.mime ?? "image/png", data: f.data ?? "" }
    : { filename: f.filename, text: f.text }));
}

/** Clipboard / drag-and-drop images usually arrive as "image.png" (or nameless): give each a unique, readable name. */
export function nameFile(f: File, n: number): File {
  const generic = !f.name || /^image\.(png|jpe?g|gif|webp)$/i.test(f.name);
  if (!generic || !f.type.startsWith("image/")) return f;
  const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  return new File([f], `screenshot-${stamp}${n ? `-${n + 1}` : ""}.${ext}`, { type: f.type });
}

/** The files in a paste event (screenshots, copied files); [] for a plain-text paste. */
export function pastedFiles(e: React.ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? []);
  return items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
}

/** File attachments parsed by the backend: text (txt, md, pdf, code) and, with `images`, png / jpg / gif / webp. */
export function useAttachments({ images = false, initial = [] }: { images?: boolean; initial?: ParsedFileOut[] } = {}) {
  const [files, setFiles] = React.useState<ParsedFileOut[]>(initial);
  const [uploading, setUploading] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list).map(nameFile);
    if (!images && picked.some((f) => f.type.startsWith("image/"))) {
      toast.error("Images can't be attached here", { description: "Attach txt, md, pdf or code files." });
      return;
    }
    setUploading(true);
    try {
      for (const f of picked.slice(0, MAX_ATTACHMENTS)) {
        const fd = new FormData();
        fd.append("file", f);
        try {
          const res = await fetchRaw("/api/v1/files/parse", { method: "POST", body: fd });
          const parsed = (await res.json()) as ParsedFileOut;
          setFiles((prev) => {
            const rest = prev.filter((p) => p.filename !== parsed.filename);
            if (rest.length >= MAX_ATTACHMENTS) { toast.error(`At most ${MAX_ATTACHMENTS} attachments`); return prev; }
            if (isImage(parsed) && rest.filter(isImage).length >= MAX_IMAGES) { toast.error(`At most ${MAX_IMAGES} images`); return prev; }
            return [...rest, parsed];
          });
          if (parsed.truncated) toast.warning(`${parsed.filename} was truncated to ${parsed.chars.toLocaleString()} chars`);
        } catch (e) {
          toast.error(`Could not attach ${f.name}`, { description: (e as Error).message });
        }
      }
    } finally {
      setUploading(false);
    }
  };
  const input = (
    <input ref={ref} type="file" hidden multiple accept={images ? `${IMAGE_ACCEPT},${TEXT_ACCEPT}` : TEXT_ACCEPT} data-testid="attach-input"
      onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
  );
  /** onPaste for a text field: pasted screenshots / files become attachments, plain text pastes normally. */
  const onPaste = (e: React.ClipboardEvent) => {
    const got = pastedFiles(e);
    if (!got.length) return;
    e.preventDefault();
    void upload(got);
  };
  /** onDragOver / onDrop for a drop zone. */
  const drop = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); },
    onDrop: (e: React.DragEvent) => { if (e.dataTransfer?.files.length) { e.preventDefault(); void upload(e.dataTransfer.files); } },
  };
  return {
    files, uploading, input, upload, onPaste, drop, setFiles,
    pick: () => ref.current?.click(),
    remove: (name: string) => setFiles((f) => f.filter((x) => x.filename !== name)),
    clear: () => setFiles([]),
  };
}

export function AttachmentChips({ files, onRemove }: { files: ParsedFileOut[]; onRemove?: (name: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="attachment-chips">
      {files.map((f) => isImage(f) ? (
        <span key={f.filename} className="group relative inline-flex animate-in zoom-in-95" title={f.filename}>
          <img src={imageSrc(f)} alt={f.filename} className="h-12 w-16 rounded-md border border-border object-cover" data-testid="attachment-thumb" />
          {onRemove && <button onClick={() => onRemove(f.filename)} aria-label={`Remove ${f.filename}`}
            className="absolute -right-1 -top-1 rounded-full border border-border bg-elevated p-px shadow hover:bg-accent"><X className="h-3 w-3" /></button>}
        </span>
      ) : (
        <span key={f.filename} className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] animate-in zoom-in-95">
          <FileText className="h-3 w-3 text-primary" />
          <span className="max-w-[140px] truncate">{f.filename}</span>
          <span className="text-muted-foreground">{(f.chars / 1000).toFixed(1)}k</span>
          {onRemove && <button onClick={() => onRemove(f.filename)} aria-label={`Remove ${f.filename}`} className="rounded hover:bg-accent"><X className="h-3 w-3" /></button>}
        </span>
      ))}
    </div>
  );
}
