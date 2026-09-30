import * as React from "react";
import { toast } from "sonner";
import { FileText, X } from "lucide-react";
import { fetchRaw } from "@/lib/api";
import type { ParsedFileOut } from "@/types";

const ACCEPT = ".txt,.md,.markdown,.pdf,.py,.js,.ts,.tsx,.jsx,.json,.yaml,.yml,.toml,.html,.css,.java,.go,.rs,.c,.cpp,.h,.rb,.php,.sh,.sql,.csv,.xml";

/** File attachments parsed to text by the backend (txt, md, pdf, code). */
export function useAttachments() {
  const [files, setFiles] = React.useState<ParsedFileOut[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  const upload = async (list: FileList | File[]) => {
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 5)) {
        const fd = new FormData();
        fd.append("file", f);
        try {
          const res = await fetchRaw("/api/v1/files/parse", { method: "POST", body: fd });
          const parsed = (await res.json()) as ParsedFileOut;
          setFiles((prev) => [...prev.filter((p) => p.filename !== parsed.filename), parsed]);
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
    <input ref={ref} type="file" hidden multiple accept={ACCEPT} onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
  );
  return {
    files, uploading, input, upload,
    pick: () => ref.current?.click(),
    remove: (name: string) => setFiles((f) => f.filter((x) => x.filename !== name)),
    clear: () => setFiles([]),
  };
}

export function AttachmentChips({ files, onRemove }: { files: ParsedFileOut[]; onRemove?: (name: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {files.map((f) => (
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
