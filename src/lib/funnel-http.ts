import { CrmCommandError } from "@/lib/crm-command";

export async function readFunnelJson(request: Request, limit: number): Promise<Record<string, unknown>> {
  if (!request.body || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new CrmCommandError("INVALID_REQUEST", "Eine Formularanfrage ist erforderlich.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CrmCommandError("REQUEST_TIMEOUT", "Die Anfrage hat zu lange gedauert.", 408)), 20000); });
  try {
    for (;;) { const part = await Promise.race([reader.read(), timeout]); if (part.done) break; length += part.value.byteLength; if (length > limit) throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Die Anfrage ist zu groß.", 413); chunks.push(part.value); }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
  try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new CrmCommandError("INVALID_JSON", "Die Anfrage konnte nicht gelesen werden."); }
}
