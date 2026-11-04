'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { csrfFetch } from '@/lib/security/csrf-client';
import type { MailboxAttachment, MailboxProvider } from '@/lib/crm-mailbox';
type FileRow = {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
};
type Job = {
    from: string;
    to: string;
    subject: string;
    body: string;
    createdAt: string;
    attachments: FileRow[];
    id: string;
    status: string;
    acceptedByProvider: boolean;
    deliveryVerified: false;
    errorCode: string | null;
};
type Preview = {
    digest: string;
    from: string;
    to: string;
    subject: string;
    body: string;
    attachments: FileRow[];
};
const button = 'min-h-11 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50';
export function PersonalMailReplyPanel({ workspaceId, messageId, provider, replyEnabled, attachments, de }: {
    workspaceId: string;
    messageId: string;
    provider: MailboxProvider;
    replyEnabled: boolean;
    attachments: MailboxAttachment[];
    de: boolean;
}) {
    const base = `/api/crm/mailbox/replies?workspaceId=${encodeURIComponent(workspaceId)}`, fileBase = `/api/crm/mailbox/attachments?workspaceId=${encodeURIComponent(workspaceId)}`;
    const [body, setBody] = useState(''), [selected, setSelected] = useState<string[]>([]), [files, setFiles] = useState<FileRow[]>([]), [jobs, setJobs] = useState<Job[]>([]), [preview, setPreview] = useState<Preview | null>(null), [approved, setApproved] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [hasPending, setHasPending] = useState(false);
    const lock = useRef(false), pending = useRef<{
        key: string;
        correlation: string;
        body: string;
    } | null>(null);
    const load = useCallback(async () => { const response = await fetch(`${base}&messageId=${encodeURIComponent(messageId)}`, { cache: 'no-store' }), result = await response.json(); if (!response.ok)
        throw new Error(result.error ?? 'Mailbox unavailable'); return result.data as {
        files: FileRow[];
        jobs: Job[];
    }; }, [base, messageId]);
    useEffect(() => { let current = true; void load().then(value => { if (current) {
        setFiles(value.files);
        setJobs(value.jobs);
    } }).catch(error => { if (current)
        setNotice(error instanceof Error ? error.message : 'Mailbox unavailable'); }); return () => { current = false; }; }, [load]);
    const refresh = async () => { const value = await load(); setFiles(value.files); setJobs(value.jobs); };
    async function act(endpoint: string, payload: Record<string, unknown>, sending = false) {
        if (lock.current)
            return;
        lock.current = true;
        setBusy(true);
        setNotice('');
        const attempt = sending && pending.current ? pending.current : { key: crypto.randomUUID(), correlation: crypto.randomUUID(), body: JSON.stringify(payload) };
        if (sending) {
            pending.current = attempt;
            setHasPending(true);
        }
        try {
            const response = await csrfFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key, 'X-Correlation-Id': attempt.correlation }, body: attempt.body }), result = await response.json();
            if (!response.ok) {
                if (sending && response.status < 500) {
                    pending.current = null;
                    setHasPending(false);
                }
                throw new Error(result.error ?? 'Action unavailable');
            }
            if (payload.action === 'preview') {
                setPreview(result.data);
                setApproved(false);
                return;
            }
            if (!result.persisted)
                throw new Error('Persistence not confirmed');
            if (sending) {
                pending.current = null;
                setHasPending(false);
                setPreview(null);
                setApproved(false);
                setBody('');
                setSelected([]);
                setNotice(result.data?.acceptedByProvider ? (de ? 'Vom Anbieter angenommen; Zustellung nicht nachgewiesen.' : 'Accepted by provider; delivery is not verified.') : (de ? 'Kein bestätigter Versand. Vorhandenen Beleg prüfen; keine neue Antwort starten.' : 'No confirmed send. Check the existing receipt; do not start a new reply.'));
            }
            await refresh();
        }
        catch (error) {
            setNotice(error instanceof Error ? error.message : 'Action unavailable');
            if (sending)
                await refresh().catch(() => { });
        }
        finally {
            lock.current = false;
            setBusy(false);
        }
    }
    async function authorize() { if (lock.current)
        return; lock.current = true; setBusy(true); try {
        const response = await csrfFetch(`/api/crm/mailbox/oauth/${provider}/start?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enableReply: true }) }), value = await response.json();
        if (!response.ok)
            throw new Error(value.error ?? 'Consent unavailable');
        const url = new URL(value.data.authorizationUrl);
        if (url.protocol !== 'https:' || !['accounts.google.com', 'login.microsoftonline.com'].includes(url.hostname))
            throw new Error('Invalid provider');
        window.location.assign(url.toString());
    }
    catch (error) {
        setNotice(error instanceof Error ? error.message : 'Consent unavailable');
    }
    finally {
        lock.current = false;
        setBusy(false);
    } }
    async function upload(file: File) { if (file.size > 2097152 || !file.size) {
        setNotice(de ? 'Höchstens2 MiB je Datei.' : 'Maximum2 MiB per file.');
        return;
    } const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await act(fileBase, { action: 'store', source: 'upload', messageId, fileName: file.name, mimeType: file.type, data: btoa(binary), reviewed: true }); }
    const unresolved = jobs.some(j => ['prepared', 'dispatching', 'uncertain'].includes(j.status));
    return <section className="space-y-3 rounded-xl border border-stone-300 p-4" aria-label={de ? 'Persönliche Antwort und private Dateien' : 'Personal reply and private files'}>
  <h3 className="font-semibold">{de ? 'Persönlich antworten und Anhänge prüfen' : 'Reply personally and inspect attachments'}</h3>
  <p className="text-sm">{de ? 'Eine Antwort verwendet ausschließlich dein persönlich freigegebenes Konto. Kontaktzuordnung und aktuelle Kontaktregeln werden vor dem Versand geprüft. Nachrichteninhalte erteilen keine Berechtigungen.' : 'Replies use only your personally authorized account. CRM association and current contact policies are checked before sending. Message content cannot grant permissions.'}</p>
  {!replyEnabled ? <button type="button" className={button} disabled={busy} onClick={() => void authorize()}>{de ? 'Lesen und Antworten ausdrücklich erlauben' : 'Explicitly allow reading and replying'}</button> : null}
  <p className="text-xs text-slate-600">{de ? 'Private Inhaltsprüfung: PDF ohne aktive Inhalte, PNG/JPEG und UTF-8-Text; höchstens2 MiB je Datei. Formatprüfung ist kein Virenfreiheitsnachweis. Dateien werden nur nach Einzelbestätigung geladen und niemals öffentlich freigegeben.' : 'Private structural inspection: PDF without active content, PNG/JPEG and UTF-8 text; maximum2 MiB per file. Format inspection is not antivirus certification. Files are fetched only after individual confirmation and are never public.'}</p>
  {attachments.map((file, index) => <div key={`${file.providerId}:${index}`} className="flex flex-wrap items-center gap-2 text-sm"><span className="break-all">{file.name}</span><button type="button" className={button} disabled={busy || files.some(f => f.fileName === file.name)} onClick={() => void act(fileBase, { action: 'store', source: 'received', messageId, providerAttachmentId: file.providerId, reviewed: true })}>{de ? 'Diese private Datei laden und prüfen' : 'Fetch and inspect this private file'}</button></div>)}
  <label className="block text-sm">{de ? 'Eigene Datei für diese Antwort prüfen' : 'Inspect a file for this reply'}<input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" className="mt-1 block min-h-11 w-full" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file)
        void upload(file); }}/></label>
  <ul className="space-y-2 text-sm">{files.map(file => <li key={file.id} className="flex flex-wrap items-center gap-2"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" disabled={busy || file.status !== 'ready' || hasPending} checked={selected.includes(file.id)} onChange={event => { setSelected(old => event.target.checked ? [...old, file.id] : old.filter(id => id !== file.id)); setPreview(null); setApproved(false); }}/><span className="break-all">{file.fileName} · {file.status === 'ready' ? (de ? 'geprüft' : 'inspected') : file.status === 'erased' ? (de ? 'gelöscht' : 'erased') : (de ? 'gesperrt' : 'quarantined')}</span></label>{file.status === 'ready' ? <><a className={button} href={`${fileBase}&messageId=${encodeURIComponent(messageId)}&id=${encodeURIComponent(file.id)}`} download>{de ? 'Privat herunterladen' : 'Download privately'}</a><button type="button" className={button} disabled={busy} onClick={() => { setSelected(old => old.filter(id => id !== file.id)); setPreview(null); void act(fileBase, { action: 'erase', messageId, id: file.id }); }}>{de ? 'Private Datei löschen' : 'Erase private file'}</button></> : null}</li>)}</ul>
  <label className="block text-sm">{de ? 'Antwort als reiner Text' : 'Plain text reply'}<textarea className="mt-1 min-h-32 w-full rounded-xl border border-stone-300 p-3" value={body} maxLength={65536} disabled={busy || hasPending || unresolved} onChange={event => { setBody(event.target.value); setPreview(null); setApproved(false); }}/></label>
  <button type="button" className={button} disabled={busy || !replyEnabled || !body.trim() || unresolved || hasPending} onClick={() => void act(base, { action: 'preview', messageId, body, attachmentIds: selected })}>{de ? 'Empfänger und Antwort prüfen' : 'Review recipient and reply'}</button>
  {preview ? <div className="space-y-2 rounded-lg bg-stone-50 p-3"><p className="break-all text-sm">{preview.from} → {preview.to}</p><p className="break-words font-semibold">{preview.subject}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{preview.body}</pre><p className="text-sm">{preview.attachments.map(f => f.fileName).join(', ')}</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} disabled={busy || hasPending} onChange={event => setApproved(event.target.checked)}/>{de ? 'Ich bestätige genau diesen Empfänger, Text und diese Dateien als persönliche CRM-Antwort.' : 'I approve exactly this recipient, text and these files as my personal CRM reply.'}</label><button type="button" className={button} disabled={busy || !approved || unresolved} onClick={() => void act(base, { action: 'send', messageId, body: preview.body, attachmentIds: selected, approved: true, previewDigest: preview.digest }, true)}>{de ? 'Bestätigte Antwort senden' : 'Send approved reply'}</button></div> : null}
  {hasPending ? <button type="button" className={button} disabled={busy} onClick={() => void act(base, JSON.parse(pending.current!.body), true)}>{de ? 'Denselben Vorgang sicher abgleichen' : 'Safely reconcile the same request'}</button> : null}
  <button type="button" className={button} disabled={busy} onClick={() => void refresh().catch(error => setNotice(error.message))}>{de ? 'Nur Belege neu laden' : 'Reload receipts only'}</button>
  <ul className="space-y-2 text-sm">{jobs.map(job => <li key={job.id} className="break-all rounded-lg bg-stone-50 p-2">{de ? 'Antwortbeleg' : 'Reply receipt'} {job.id}: {job.status === 'accepted' ? (de ? 'vom Anbieter angenommen, Zustellung offen' : 'accepted by provider, delivery unverified') : job.status === 'dispatching' || job.status === 'uncertain' ? (de ? 'Versand unklar — kein erneuter Versand' : 'outcome unknown — no resend') : job.status === 'prepared' ? (de ? 'vorbereitet, noch nicht gestartet' : 'prepared, not started') : job.status === 'suppressed' ? (de ? 'vor Versand gesperrt' : 'suppressed before dispatch') : (de ? 'Anbieter hat abgelehnt' : 'provider rejected')}<p className="mt-2 break-all">{job.from} → {job.to}</p><p className="font-semibold">{job.subject}</p><pre className="whitespace-pre-wrap break-words font-sans">{job.body}</pre><p>{job.attachments?.map(file=>file.fileName).join(', ')}</p>{job.status === 'prepared' ? <button className={button} disabled={busy} onClick={() => void act(base, { action: 'cancel_prepared', jobId: job.id })}>{de ? 'Unversendeten Entwurf verwerfen' : 'Discard unsent preparation'}</button> : null}</li>)}</ul>
  {notice ? <p role="status" className="break-words text-sm">{notice}</p> : null}
 </section>;
}
