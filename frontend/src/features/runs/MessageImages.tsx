/** Images attached to a message: thumbnails that open full size. Run images are fetched with auth (they're referenced as
 *  i1, i2… in the message); direct-chat images come inline as data URLs. */
import * as React from "react";
import { ImageOff } from "lucide-react";
import { fetchRaw } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/overlays";

export interface ShownImage { name: string; src?: string; url?: string; ref?: string }

const blobs = new Map<string, string>();

function useSrc(img: ShownImage): { src?: string; failed?: boolean } {
  const [state, setState] = React.useState<{ src?: string; failed?: boolean }>(() => ({ src: img.src ?? (img.url ? blobs.get(img.url) : undefined) }));
  React.useEffect(() => {
    if (img.src || !img.url) return;
    const hit = blobs.get(img.url);
    if (hit) { setState({ src: hit }); return; }
    let alive = true;
    fetchRaw(img.url).then((r) => r.blob()).then((b) => {
      const src = URL.createObjectURL(b);
      blobs.set(img.url!, src);
      if (alive) setState({ src });
    }).catch(() => alive && setState({ failed: true }));
    return () => { alive = false; };
  }, [img.src, img.url]);
  return state;
}

function Thumb({ img, onOpen }: { img: ShownImage; onOpen: (src: string) => void }) {
  const { src, failed } = useSrc(img);
  return (
    <button type="button" onClick={() => src && onOpen(src)} title={img.ref ? `${img.name} (${img.ref})` : img.name} aria-label={`Open ${img.name}`}
      className="h-20 w-20 overflow-hidden rounded-lg border border-border bg-muted transition hover:border-primary/60" data-testid="message-image">
      {src ? <img src={src} alt={img.name} className="h-full w-full object-cover" />
        : <span className="flex h-full items-center justify-center text-muted-foreground">{failed ? <ImageOff className="h-4 w-4" /> : null}</span>}
    </button>
  );
}

export function MessageImages({ images, align = "start" }: { images: ShownImage[]; align?: "start" | "end" }) {
  const [open, setOpen] = React.useState<{ src: string; name: string } | null>(null);
  if (!images.length) return null;
  return (
    <>
      <div className={cn("flex flex-wrap gap-1.5", align === "end" && "justify-end")}>
        {images.map((img, i) => <Thumb key={img.ref ?? `${img.name}-${i}`} img={img} onOpen={(src) => setOpen({ src, name: img.name })} />)}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-[min(92vw,1200px)] p-2">
          <DialogTitle className="sr-only">{open?.name}</DialogTitle>
          {open && <img src={open.src} alt={open.name} className="max-h-[85vh] w-full rounded object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  );
}
