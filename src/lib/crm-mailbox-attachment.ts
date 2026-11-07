import 'server-only';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { CrmCommandError } from './crm-command';
import { attachmentName, MAX_PERSONAL_ATTACHMENT_BYTES, personalSha256 } from './crm-mailbox-reply';
let inspecting = 0;
export async function inspectPersonalMailAttachment(input: {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
}) {
    const name = attachmentName(input.fileName), mime = input.mimeType.toLowerCase();
    const allowed: Record<string, string[]> = { 'application/pdf': ['.pdf'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'text/plain': ['.txt'] };
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > MAX_PERSONAL_ATTACHMENT_BYTES || !Object.hasOwn(allowed, mime) || !allowed[mime].includes(path.extname(name).toLowerCase()))
        throw new CrmCommandError('MAIL_ATTACHMENT_QUARANTINED', 'Die Datei bleibt gesperrt: Unterstützt sind begrenzte PDF-, PNG-, JPEG- und UTF-8-Textdateien.', 409);
    let bytes: Uint8Array = input.bytes;
    if (mime === 'text/plain') {
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            throw new CrmCommandError('MAIL_ATTACHMENT_QUARANTINED', 'Die Datei ist kein gültiger UTF-8-Text.', 409);
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
            throw new CrmCommandError('MAIL_ATTACHMENT_QUARANTINED', 'Binäre oder aktive Dateitypen bleiben gesperrt.', 409);
    }
    else {
        if (inspecting >= 2)
            throw new CrmCommandError('MAIL_ATTACHMENT_CHECK_BUSY', 'Die Inhaltsprüfung ist ausgelastet. Bitte später erneut prüfen.', 503);
        inspecting++;
        try {
            bytes = await new Promise<Uint8Array>((resolve, reject) => {
                const worker = new Worker(path.join(process.cwd(), 'src/lib/crm-mailbox-attachment-worker.cjs'), { workerData: { bytes: Uint8Array.from(bytes), mimeType: mime }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, execArgv: [], stdout: true, stderr: true });
                worker.stdout?.resume();
                worker.stderr?.resume();
                let finished = false;
                const finish = (value?: Uint8Array) => { if (finished)
                    return; finished = true; clearTimeout(timer); void worker.terminate(); if (value instanceof Uint8Array && value.length && value.length <= MAX_PERSONAL_ATTACHMENT_BYTES)
                    resolve(value);
                else
                    reject(new CrmCommandError('MAIL_ATTACHMENT_QUARANTINED', 'Die Datei ist beschädigt, enthält aktive Inhalte oder überschreitet die Prüfgrenzen.', 409)); };
                const timer = setTimeout(() => finish(), 8000);
                worker.once('message', (result: {
                    ok?: boolean;
                    bytes?: Uint8Array;
                }) => finish(result.ok ? result.bytes : undefined));
                worker.once('error', () => finish());
                worker.once('exit', () => { if (!finished)
                    finish(); });
            });
        }
        finally {
            inspecting--;
        }
    }
    return { fileName: name, mimeType: mime, bytes, sha256: personalSha256(bytes), sizeBytes: bytes.length, checkCode: 'LOCAL_FORMAT_AND_STRUCTURE_CHECKED_NOT_ANTIVIRUS' };
}
