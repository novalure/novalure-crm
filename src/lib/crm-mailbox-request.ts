import { CrmCommandError } from './crm-command';
/** Limit actual streamed bytes, including chunked requests; never trust Content-Length alone. */
export async function readPersonalMailJson(request: Request, maxBytes: number, allowEmpty = false): Promise<Record<string, unknown>> {
    const json = request.headers.get('content-type')?.toLowerCase().startsWith('application/json');
    if (!json && !allowEmpty)
        throw new CrmCommandError('CONTENT_TYPE_REQUIRED', 'JSON erforderlich.', 415);
    const declared = request.headers.get('content-length');
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes))
        throw new CrmCommandError('REQUEST_TOO_LARGE', 'Die Anfrage überschreitet die Größenbegrenzung.', 413);
    const reader = request.body?.getReader();
    if (!reader && allowEmpty) return {};
    if (!reader)
        throw new CrmCommandError('INVALID_JSON', 'JSON-Objekt erforderlich.');
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            length += next.value.byteLength;
            if (length > maxBytes)
                throw new CrmCommandError('REQUEST_TOO_LARGE', 'Die Anfrage überschreitet die Größenbegrenzung.', 413);
            chunks.push(next.value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    if (!length && allowEmpty) return {};
    if (!json) throw new CrmCommandError('CONTENT_TYPE_REQUIRED', 'JSON erforderlich.', 415);
    try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('object');
        return value as Record<string, unknown>;
    }
    catch {
        throw new CrmCommandError('INVALID_JSON', 'JSON-Objekt erforderlich.');
    }
}
