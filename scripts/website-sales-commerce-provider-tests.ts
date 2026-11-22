import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { sendCommerceMail, retrieveCommerceMail } from '../src/lib/website-sales-commerce-provider';
import { commerceSignatureHtml, requestCommerceSignature, retrieveCommerceSignature } from '../src/lib/website-sales-commerce-signature';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function mail() {
  const id = randomUUID(), text = 'Approved canonical service scope. <script>untrusted()</script>';
  return { id, kind: 'OFFER_SEND' as const, idempotencyKey: `sales-commerce:${id}`, firstAttemptAt: new Date().toISOString(),
    payload: { documentRef: { id: randomUUID(), version: 3, digest: sha('exact canonical revision') }, documentSha256: sha(text),
      recipientEmail: 'synthetic-customer@example.invalid', recipientDigest: sha('synthetic recipient'), subject: 'Approved website offer', text, approvalReference: randomUUID() } };
}
async function endpoint<T>(run: (transport: typeof fetch, captured: { path: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }[], set: (code: number, body: unknown) => void) => Promise<T>) {
  const captured: { path: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let status = 200, reply: unknown = { id: randomUUID() };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const part of request) chunks.push(Buffer.from(part));
    captured.push({ path: request.url!, method: request.method!, headers: request.headers, body: Buffer.concat(chunks).toString() });
    const body = typeof reply === 'function' ? reply(request.url!) : reply;
    response.writeHead(status, { 'Content-Type': body instanceof Uint8Array ? 'application/pdf' : 'application/json' });
    response.end(body instanceof Uint8Array ? body : JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const transport = (async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(target.protocol, 'https:'); assert(['api.resend.com', 'api.docuseal.com', 'docuseal.com'].includes(target.hostname));
    return fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, options);
  }) as typeof fetch;
  try { return await run(transport, captured, (code, body) => { status = code; reply = body; }); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('actual loopback HTTP sends the frozen offer once with a stable key and escaped inert content; acceptance is not delivery', async () => endpoint(async (transport, captured, set) => {
  const job = mail(), providerId = randomUUID(); set(200, { id: providerId });
  const result = await sendCommerceMail(job, { apiKey: 'synthetic-key-only', from: 'Novalure <hello@novalure.eu>', transport });
  assert.equal(result.outcome, 'ACCEPTED'); assert.equal(captured.length, 1);
  assert.equal(captured[0]!.headers['idempotency-key'], job.idempotencyKey); assert.equal(captured[0]!.path, '/emails');
  const body = JSON.parse(captured[0]!.body); assert.deepEqual(body.to, [job.payload.recipientEmail]);
  assert.equal(body.text, job.payload.text); assert(!body.html.includes('<script>')); assert(body.html.includes('&lt;script&gt;'));
  assert.deepEqual(body.tags, [{ name: 'novalure_kind', value: 'sales_commerce' }, { name: 'novalure_delivery', value: job.id }]);
  assert(!('delivered' in result));
}));

test('unknown provider acceptance and conflicting in-flight requests are never reported as rejected or delivered', async () => endpoint(async (transport, _captured, set) => {
  for (const status of [500, 503, 408, 409]) {
    set(status, { error: 'synthetic upstream response' });
    assert.equal((await sendCommerceMail(mail(), { apiKey: 'synthetic', from: 'hello@novalure.eu', transport })).outcome, 'UNKNOWN');
  }
  set(200, { id: 'not-a-provider-id' });
  assert.equal((await sendCommerceMail(mail(), { apiKey: 'synthetic', from: 'hello@novalure.eu', transport })).outcome, 'UNKNOWN');
}));

test('expired provider idempotency windows and unapproved senders make no outbound call', async () => {
  let calls = 0; const transport = (async () => { calls++; throw Error('must not be called'); }) as typeof fetch;
  const job = mail(); job.firstAttemptAt = new Date(Date.now() - 23 * 3_600_000).toISOString();
  const result = await sendCommerceMail(job, { apiKey: 'synthetic', from: 'hello@novalure.eu', transport });
  assert.equal(result.outcome, 'UNKNOWN'); assert.equal(calls, 0);
  assert.equal((await sendCommerceMail(mail(), { apiKey: 'synthetic', from: 'sender@example.invalid', transport })).outcome, 'REJECTED');
  assert.equal(calls, 0);
});

test('provider retrieval binds sender recipient and actual sent content without sending another message', async () => endpoint(async (transport, captured, set) => {
  const job = mail(), providerId = randomUUID();
  set(200, { id: providerId, to: [job.payload.recipientEmail], from: 'hello@novalure.eu', subject: job.payload.subject, text: job.payload.text, last_event: 'delivered' });
  const result = await retrieveCommerceMail(providerId, { apiKey: 'synthetic', from: 'hello@novalure.eu', transport });
  assert(result); assert.equal(result.status, 'DELIVERED'); assert.equal(result.textSha256, job.payload.documentSha256);
  assert.equal(captured[0]!.method, 'GET');
  for (const last_event of ['opened', 'clicked']) {
    set(200, { id: providerId, to: [job.payload.recipientEmail], from: 'hello@novalure.eu', subject: job.payload.subject, text: job.payload.text, last_event });
    assert.equal(await retrieveCommerceMail(providerId, { apiKey: 'synthetic', from: 'hello@novalure.eu', transport }), null);
  }
  set(200, { id: providerId, to: [job.payload.recipientEmail], from: 'other@example.invalid', subject: job.payload.subject, text: job.payload.text, last_event: 'delivered' });
  assert.equal(await retrieveCommerceMail(providerId, { apiKey: 'synthetic', from: 'hello@novalure.eu', transport }), null);
}));

function signature() { const job = mail(); return { id: job.id, payload: { ...job.payload, signatureMode: 'CANONICAL_HTML' as const,
  requiredAssurance: 'PROVIDER_ATTESTED' as const, acceptUntil: new Date(Date.now() + 86_400_000).toISOString() } }; }
function submission(job: ReturnType<typeof signature>, status = 'pending') {
  return { id: 123, status, expire_at: job.payload.acceptUntil, updated_at: new Date().toISOString(), completed_at: status === 'completed' ? new Date().toISOString() : null,
    submitters: [{ id: 456, email: job.payload.recipientEmail, external_id: job.id, role: 'Customer', status: status === 'completed' ? 'completed' : 'sent',
      metadata: { commerce_job_id: job.id, document_sha256: job.payload.documentSha256, html_sha256: commerceSignatureHtml(job.payload).htmlSha256 } }] };
}
test('signature request uses the whole immutable approved body and a customer signature field, without mutable templates or auto-sign options', async () => endpoint(async (transport, captured, set) => {
  const job = signature(); set(200, submission(job));
  assert.equal((await requestCommerceSignature(job, { apiKey: 'synthetic', htmlCapabilityApproved: true, transport })).outcome, 'ACCEPTED');
  const body = JSON.parse(captured[0]!.body); assert.equal(captured[0]!.path, '/submissions/html');
  assert.equal(body.template_id, undefined); assert.equal(body.submitters[0].completed, undefined); assert.equal(body.submitters[0].values, undefined);
  assert.equal(body.submitters[0].require_email_2fa, true); assert(body.documents[0].html.includes('<signature-field'));
  assert(!body.documents[0].html.includes('<script>')); assert(body.documents[0].html.includes('&lt;script&gt;'));
  assert.throws(() => commerceSignatureHtml({ ...job.payload, text: 'changed after approval' }), /DOCUMENT_CHANGED/);
}));

test('signature transport remains unavailable without an approved actual provider capability and never treats a pending form as signed', async () => endpoint(async (transport, captured, set) => {
  const job = signature();
  assert.equal((await requestCommerceSignature(job, { apiKey: 'synthetic', htmlCapabilityApproved: false, transport })).outcome, 'REJECTED');
  assert.equal(captured.length, 0); set(200, submission(job));
  assert.equal((await requestCommerceSignature({ ...job, payload: { ...job.payload, requiredAssurance: 'QUALIFIED' } }, { apiKey: 'synthetic', htmlCapabilityApproved: true, transport })).outcome, 'REJECTED');
  assert.equal(captured.length, 0);
  const observation = await retrieveCommerceSignature(job, '123', { apiKey: 'synthetic', htmlCapabilityApproved: true, transport });
  assert(observation); assert.equal(observation.status, 'PENDING'); assert.deepEqual(observation.signedDocumentDigests, []);
  assert.equal(captured.length, 1); assert.equal(captured[0]!.method, 'GET');
}));

test('a reported completed signature requires retrievable signed PDF and audit evidence, with exact job and document bindings', async () => endpoint(async (transport, _captured, set) => {
  const job = signature(); set(200, submission(job, 'completed'));
  assert.equal(await retrieveCommerceSignature(job, '123', { apiKey: 'synthetic', htmlCapabilityApproved: true, transport }), null);
  const wrong = submission(job); wrong.submitters[0]!.metadata.document_sha256 = sha('different contract'); set(200, wrong);
  assert.equal(await retrieveCommerceSignature(job, '123', { apiKey: 'synthetic', htmlCapabilityApproved: true, transport }), null);
}));

test('an unknown signature request reconciles with read requests only; absence or duplicate matches never permits a second create', async () => endpoint(async (transport, captured, set) => {
  const job = signature(); set(200, { data: [] });
  assert.equal(await retrieveCommerceSignature(job, null, { apiKey: 'synthetic', htmlCapabilityApproved: true, transport }), null);
  set(200, { data: [submission(job), submission(job)] });
  assert.equal(await retrieveCommerceSignature(job, null, { apiKey: 'synthetic', htmlCapabilityApproved: true, transport }), null);
  assert(captured.every(row => row.method === 'GET'));
}));

test('completed signatures bind actual fetched signed PDF and audit bytes; rotating file URLs preserve the semantic proof', async () => endpoint(async (transport, captured, set) => {
  const job = signature(), document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText('Synthetic signed-contract fixture, no customer signature', { font, size: 12 });
  const signed = await document.save();
  const audit = await PDFDocument.create(); audit.addPage().drawText('Synthetic provider audit fixture'); const auditBytes = await audit.save();
  const data = { ...submission(job, 'completed'), documents: [{ name: 'Contract.pdf', url: 'https://docuseal.com/file/synthetic-contract.pdf?token=one' }],
    audit_log_url: 'https://docuseal.com/file/synthetic-audit.pdf?token=one' };
  set(200, (path: string) => path.startsWith('/file/synthetic-contract') ? signed : path.startsWith('/file/') ? auditBytes : data);
  const first = await retrieveCommerceSignature(job, '123', { apiKey: 'synthetic', htmlCapabilityApproved: true, transport });
  assert(first); assert.equal(first.status, 'SIGNED');
  assert.deepEqual(first.signedDocumentDigests, [createHash('sha256').update(signed).digest('hex')]);
  assert.deepEqual(first.auditProofDigests, [createHash('sha256').update(auditBytes).digest('hex')]);
  assert(captured.filter(row => row.path.startsWith('/file/')).every(row => !row.headers['x-auth-token']));
  data.documents[0]!.url = 'https://docuseal.com/file/synthetic-contract.pdf?token=two';
  data.audit_log_url = 'https://docuseal.com/file/synthetic-audit.pdf?token=two';
  const second = await retrieveCommerceSignature(job, '123', { apiKey: 'synthetic', htmlCapabilityApproved: true, transport });
  assert.equal(second?.receiptDigest, first.receiptDigest);
  data.documents[0]!.url = 'https://untrusted.example.invalid/file/contract.pdf';
  assert.equal(await retrieveCommerceSignature(job, '123', { apiKey: 'synthetic', htmlCapabilityApproved: true, transport }), null);
}));

test('archived signature records make the source unavailable without inventing a legal revocation; expired invitations never send', async () => endpoint(async (transport, captured, set) => {
  const job = signature(), archivedAt = new Date().toISOString();
  set(200, { ...submission(job, 'completed'), archived_at: archivedAt });
  const observed = await retrieveCommerceSignature(job, '123', { apiKey: 'synthetic', htmlCapabilityApproved: true, transport });
  assert.equal(observed?.status, 'SOURCE_UNAVAILABLE'); assert.equal(observed?.providerArchivedAt, archivedAt);
  const expired = { ...job, payload: { ...job.payload, acceptUntil: new Date(Date.now() - 1000).toISOString() } };
  assert.equal((await requestCommerceSignature(expired, { apiKey: 'synthetic', htmlCapabilityApproved: true, transport })).outcome, 'REJECTED');
  assert(captured.every(row => row.method === 'GET'));
}));
