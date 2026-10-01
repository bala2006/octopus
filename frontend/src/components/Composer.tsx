/** The message box used everywhere you talk to agents (direct chat, company channel, live runs): multi-line text, text files
 *  (txt, md, pdf, code) and images (pick, paste or drop). Enter sends, Shift+Enter adds a line. */
import * as React from "react";
import { toast } from "sonner";
import { ImagePlus, Paperclip, Send, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { clipboardImages, isImage, MAX_IMAGES, prepareImage, type PendingImage } from "@/lib/images";
import type { ParsedFileOut } from "@/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { Tip } from "@/components/ui/overlays";
import { AttachmentChips, useAttachments } from "@/features/chat/attachments";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // what one message may carry (the socket limit is 16 MB, base64 adds a third)

export interface ComposerPayload { text: string; files: ParsedFileOut[]; images: PendingImage[] }

export function Composer({ placeholder, busy, onSend, onStop, disabled, extra, hint, className, ariaLabel = "Message", testId = "composer" }: {
  placeholder: string; busy?: boolean; onSend: (p: ComposerPayload) => void; onStop?: () => void; disabled?: boolean;
  extra?: React.ReactNode; hint?: React.ReactNode; className?: string; ariaLabel?: string; testId?: string;
}) {
  const [text, setText] = React.useState("");
  const [images, setImages] = React.useState<PendingImage[]>([]);
  const [reading, setReading] = React.useState(false);
  const att = useAttachments();
  const [drag, setDrag] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const imageInput = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (ref.current) { ref.current.style.height = "auto"; ref.current.style.height = `${Math.min(240, ref.current.scrollHeight)}px`; } }, [text]);

  const addImages = async (files: File[]) => {
    const room = MAX_IMAGES - images.length;
    if (room <= 0) { toast.error(`At most ${MAX_IMAGES} images per message`); return; }
    if (files.length > room) toast.warning(`Only the first ${room} image(s) were added (at most ${MAX_IMAGES} per message)`);
    setReading(true);
    try {
      for (const f of files.slice(0, room)) {
        try {
          const img = await prepareImage(f);
          let fits = true;
          setImages((prev) => {
            fits = prev.reduce((n, x) => n + x.bytes, 0) + img.bytes <= MAX_TOTAL_BYTES;
            return fits ? [...prev, img] : prev;
          });
          if (!fits) toast.error(`${img.name} not added: images in one message can total at most 10 MB`);
        } catch (e) {
          toast.error((e as Error).message);
        }
      }
    } finally {
      setReading(false);
    }
  };
  const addFiles = (list: FileList | File[]) => {
    const all = Array.from(list);
    const pics = all.filter(isImage);
    const docs = all.filter((f) => !isImage(f));
    if (pics.length) void addImages(pics);
    if (docs.length) void att.upload(docs);
  };
  const empty = !text.trim() && !att.files.length && !images.length;
  const submit = () => {
    if (empty || busy || disabled || reading || att.uploading) return;
    onSend({ text: text.trim(), files: att.files, images });
    setText("");
    setImages([]);
    att.clear();
  };

  return (
    <div className={cn("px-3 pb-3 pt-1", className)}>
      <div className={cn("rounded-xl border bg-background shadow-sm transition-colors focus-within:border-primary/50", drag ? "border-dashed border-primary" : "border-border")}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
        {(images.length > 0 || att.files.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2" data-testid={`${testId}-attachments`}>
            {images.map((img) => (
              <span key={img.id} className="group relative h-14 w-14 overflow-hidden rounded-md border border-border bg-muted animate-in zoom-in-95">
                <img src={img.dataUrl} alt={img.name} title={`${img.name} · ${img.width}×${img.height}`} className="h-full w-full object-cover" />
                <button onClick={() => setImages((p) => p.filter((x) => x.id !== img.id))} aria-label={`Remove ${img.name}`}
                  className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 opacity-0 shadow transition group-hover:opacity-100 focus:opacity-100"><X className="h-3 w-3" /></button>
              </span>
            ))}
            <AttachmentChips files={att.files} onRemove={att.remove} />
          </div>
        )}
        <Textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={1} disabled={disabled}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          onPaste={(e) => { const pics = clipboardImages(e.clipboardData); if (pics.length) { e.preventDefault(); void addImages(pics); } }}
          className="min-h-[44px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" aria-label={ariaLabel} data-testid={testId} />
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <Tip content="Attach txt, md, pdf or code"><Button variant="ghost" size="icon-sm" onClick={att.pick} loading={att.uploading} aria-label="Attach file"><Paperclip /></Button></Tip>
          {att.input}
          <Tip content="Add images (you can also paste or drop them)">
            <Button variant="ghost" size="icon-sm" onClick={() => imageInput.current?.click()} loading={reading} aria-label="Add image"><ImagePlus /></Button>
          </Tip>
          <input ref={imageInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" data-testid={`${testId}-image-input`}
            onChange={(e) => { if (e.target.files) void addImages(Array.from(e.target.files)); e.target.value = ""; }} />
          {extra}
          <span className="ml-auto hidden text-[10px] text-muted-foreground sm:inline">{hint ?? <><kbd className="kbd">Enter</kbd> send · <kbd className="kbd">Shift+Enter</kbd> newline</>}</span>
          {busy && onStop ? (
            <Button size="sm" variant="secondary" onClick={onStop}><Square className="fill-current" />Stop</Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={empty || disabled || reading || att.uploading} aria-label="Send"><Send />Send</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** For sending: images as {name, data_url}, text files as {filename, text}. */
export const wireImages = (images: PendingImage[]) => images.map((i) => ({ name: i.name, data_url: i.dataUrl }));
export const wireFiles = (files: ParsedFileOut[]) => files.map((a) => ({ filename: a.filename, text: a.text }));
