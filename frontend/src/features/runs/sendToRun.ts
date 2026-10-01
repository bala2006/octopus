import { toast } from "sonner";
import { fetchRaw } from "@/lib/api";
import { type ComposerPayload, wireFiles, wireImages } from "@/components/Composer";

/** Text goes over the run socket; messages with files or images go over REST (images can be several MB). */
export async function sendToRun(w: string, runId: string, p: ComposerPayload, to: string | undefined, send: (m: Record<string, unknown>) => void) {
  if (!p.images.length && !p.files.length) { send({ type: "interject", content: p.text, to_agent_id: to }); return; }
  try {
    await fetchRaw(`/api/v1/w/${w}/runs/${runId}/interject`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: p.text, to_agent_id: to ?? null, attachments: wireFiles(p.files), images: wireImages(p.images) }) });
  } catch (e) {
    toast.error("Message not sent", { description: (e as Error).message });
  }
}

