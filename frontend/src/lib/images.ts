/** Images attached to messages: pasted, dropped or picked, shrunk to a size the model reads well and the socket accepts. */

export interface PendingImage { id: string; name: string; dataUrl: string; width: number; height: number; bytes: number }

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGES = 4;
export const MAX_SIDE = 2048; // longer side after resizing; models downscale larger images anyway
const MAX_BYTES = 4 * 1024 * 1024; // the backend accepts 5 MB; leave headroom for re-encoding

export const isImage = (f: File) => IMAGE_TYPES.includes(f.type);

/** Size that fits within `max` on the longer side, keeping the aspect ratio (never enlarges). */
export function fitWithin(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const dataUrlBytes = (url: string) => Math.floor(((url.split(",", 2)[1] ?? "").length * 3) / 4);

const readAsDataUrl = (f: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error ?? new Error("Could not read the image"));
  r.readAsDataURL(f);
});

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("Not a readable image"));
  img.src = src;
});

/** Read an image file; large ones are scaled down (and re-encoded as JPEG unless they're small PNGs, e.g. screenshots). */
export async function prepareImage(file: File): Promise<PendingImage> {
  if (!isImage(file)) throw new Error(`${file.name || "This file"} is not a PNG, JPEG, WebP or GIF image`);
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const size = fitWithin(img.naturalWidth, img.naturalHeight);
  const name = file.name || `pasted-image.${file.type.split("/")[1]}`;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const small = size.width === img.naturalWidth && dataUrlBytes(original) <= MAX_BYTES;
  if (small || file.type === "image/gif") { // keep as is (GIFs would lose their animation)
    if (dataUrlBytes(original) > MAX_BYTES) throw new Error(`${name} is larger than 4 MB`);
    return { id, name, dataUrl: original, width: img.naturalWidth, height: img.naturalHeight, bytes: dataUrlBytes(original) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d")?.drawImage(img, 0, 0, size.width, size.height);
  let url = canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.88);
  if (dataUrlBytes(url) > MAX_BYTES) url = canvas.toDataURL("image/jpeg", 0.8);
  if (dataUrlBytes(url) > MAX_BYTES) throw new Error(`${name} is too large even after resizing`);
  return { id, name, dataUrl: url, width: size.width, height: size.height, bytes: dataUrlBytes(url) };
}

/** Images on the clipboard (a pasted screenshot), if any. */
export const clipboardImages = (data: DataTransfer | null): File[] =>
  Array.from(data?.items ?? []).filter((i) => i.kind === "file" && IMAGE_TYPES.includes(i.type)).map((i) => i.getAsFile()).filter((f): f is File => !!f);
