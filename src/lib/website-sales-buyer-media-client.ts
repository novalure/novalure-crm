'use client';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const assetPathPattern = /^\/api\/public\/website-sales\/advisory\/assets\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const maximumBytes = 25_000_000;
const mediaTypes = new Set(['video/mp4', 'video/webm']);

/** Token stays in a same-origin header. Only exact, bounded, hash-confirmed video bytes become a temporary browser URL. */
export async function loadBuyerVideo(token: string, asset: { mediaPath: string; sha256: string }, source?: AbortSignal): Promise<string> {
  if (!tokenPattern.test(token) || !assetPathPattern.test(asset.mediaPath) || !digestPattern.test(asset.sha256)) throw Error('BUYER_MEDIA_REFERENCE_INVALID');
  const controller = new AbortController(), abort = () => controller.abort();
  source?.addEventListener('abort', abort, { once: true });
  if (source?.aborted) abort();
  const timeout = setTimeout(abort, 30000);
  try {
    const response = await fetch(asset.mediaPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'x-sales-review-token': token, Accept: 'video/mp4, video/webm' }, signal: controller.signal });
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), declared = response.headers.get('content-length');
    if (!response.ok || !type || !mediaTypes.has(type) || declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw Error('BUYER_MEDIA_UNAVAILABLE');
    const reader = response.body?.getReader();
    if (!reader) throw Error('BUYER_MEDIA_UNAVAILABLE');
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    let bytes: Uint8Array;
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        if (controller.signal.aborted) throw Error('BUYER_MEDIA_UNAVAILABLE');
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > maximumBytes) throw Error('BUYER_MEDIA_TOO_LARGE');
        chunks.push(next.value);
      }
      if (!length || controller.signal.aborted) throw Error('BUYER_MEDIA_UNAVAILABLE');
      bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } finally { controller.signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)), value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.sha256 || controller.signal.aborted) throw Error('BUYER_MEDIA_PROOF_MISMATCH');
    return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type }));
  } finally { clearTimeout(timeout); source?.removeEventListener('abort', abort); }
}

/** Owner side only: the secret is returned to volatile UI state, never the command or recovery journal. */
export async function createBuyerGrantSecret(): Promise<{ token: string; tokenHash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), value => value.toString(16).padStart(2, '0')).join('');
  return { token, tokenHash };
}
