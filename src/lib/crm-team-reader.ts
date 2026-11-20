"use client";

export const crmTeamResponseByteLimit = 1024 * 1024;
const crmTeamReadDeadlineMs = 15000;

/** A scope change retires its result, not an already dispatched response body.
 * Native headers can arrive before the fetch continuation runs, so aborting on
 * a JS-only "headers seen" flag can still interrupt an actual successful body. */
export function createCrmTeamRead(url: string, deadlineMs = crmTeamReadDeadlineMs) {
  const controller = new AbortController();
  let retired = false, dispatched = false;
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const promise = Promise.resolve().then(async () => {
    if (retired) throw new DOMException("Scope retired before dispatch", "AbortError");
    dispatched = true;
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) throw Error("Team response has no body");
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = []; let length = 0, eof = false;
    try {
      for (;;) {
        if (controller.signal.aborted) throw Error("Team read deadline exceeded");
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > crmTeamResponseByteLimit) throw Error("Team response exceeds byte limit");
        chunks.push(next.value);
      }
      if (controller.signal.aborted) throw Error("Team read deadline exceeded");
      eof = true;
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return { response, payload };
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      if (!eof) { controller.abort(); cancel(); }
      reader.releaseLock();
    }
  }).finally(() => clearTimeout(timer));
  return { promise, isCurrent: () => !retired, retire: () => { retired = true; if (!dispatched) controller.abort(); } };
}
