import 'server-only';
import { z, ZodError } from 'zod';
import { createHash } from 'node:crypto';
import { getRequestSession, type AppSession } from './auth/session';
import { getTrustedAppOrigin } from './auth/app-origin';
import { enforceCsrfForSession } from './security/csrf';
import { validateCsrfIssuanceContext, validateCsrfRequestContext } from './security/csrf-core';
import { CrmCommandError, crmRequestMetadata } from './crm-command';
import { readKnowledgeJson } from './knowledge-center/http';
import { KnowledgeCenterError } from './knowledge-center/policy';
import { advisoryBuyerCommandSchema, advisoryBuyerProjectionSchema, advisoryBuyerReceiptSchema, advisoryBuyerReconcileSchema } from './website-sales-advisory-types';
import { advisoryBuyerActorBindingHash } from './website-sales-advisory-domain';

type BuyerCommand = z.infer<typeof advisoryBuyerCommandSchema>;
export interface WebsiteSalesBuyerHttpPorts {
  read(token: string, session: AppSession | null): Promise<unknown>;
  confirm(session: AppSession, token: string, command: BuyerCommand): Promise<unknown>;
  reconcile(session: AppSession, token: string, command: BuyerCommand): Promise<unknown>;
  asset(token: string, assetId: string, session: AppSession | null): Promise<{ bytes: Uint8Array; mediaType: 'video/webm'; sha256: string; filename: string }>;
  session?(request: Request): Promise<AppSession | null>;
  csrf?: typeof enforceCsrfForSession;
  trustedOrigin?: string;
}
const commonHeaders = { 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, noarchive, nofollow', Vary: 'Cookie, x-sales-review-token' };
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: commonHeaders }); }
function denied(status = 403): never { throw new CrmCommandError('BUYER_ACCESS_UNAVAILABLE', 'Buyer access unavailable', status); }
function readToken(request: Request): string {
  if (new URL(request.url).search || request.headers.has('authorization')) denied(400);
  const value = request.headers.get('x-sales-review-token') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) denied();
  return value;
}
async function currentSession(request: Request, ports: WebsiteSalesBuyerHttpPorts): Promise<AppSession | null> {
  const session = await (ports.session ?? getRequestSession)(request);
  if (!session) return null;
  if (!session.authenticated || session.serviceIdentity || !['cookie', 'database'].includes(session.source)
    || !session.authIdentityId || !session.authSessionId) denied();
  return session;
}
function safeRead(value: unknown, session: AppSession | null) {
  const parsed = advisoryBuyerProjectionSchema.safeParse(value); if (!parsed.success) throw Error('Buyer projection unconfirmed');
  const data = parsed.data;
  if (data.canWrite && (!session || data.actorUserId !== session.userId || data.authAssurance !== 'AUTHENTICATED_ACCOUNT'
    || data.actorBindingHash !== advisoryBuyerActorBindingHash({ principalUserId: session.userId, authIdentityId: session.authIdentityId!,
      workspaceId: session.workspaceId, grantId: data.grantId, packetRef: data.packetRef }))) denied();
  return data;
}
function failure(error: unknown): Response {
  if (error instanceof ZodError) return json({ code: 'INVALID_BUYER_PAYLOAD' }, 400);
  if (error instanceof KnowledgeCenterError && [400, 413, 415].includes(error.status)) return json({ code: 'INVALID_BUYER_PAYLOAD' }, error.status);
  if (error instanceof CrmCommandError) {
    const status = [400, 401, 403, 404, 409, 413, 415].includes(error.status) ? error.status : 503;
    const code = status === 401 ? 'BUYER_LOGIN_REQUIRED' : status === 409 ? 'BUYER_VERSION_OR_REQUEST_CONFLICT'
      : status === 503 ? 'BUYER_OUTCOME_UNCONFIRMED' : 'BUYER_ACCESS_UNAVAILABLE';
    return json({ code }, status);
  }
  return json({ code: 'BUYER_OUTCOME_UNCONFIRMED' }, 503);
}
function safeReceipt(value: unknown, command: BuyerCommand, session: AppSession) {
  const parsed = advisoryBuyerReceiptSchema.safeParse(value); if (!parsed.success) throw Error('Buyer receipt unconfirmed');
  const data = parsed.data;
  if (data.correlationId !== command.correlationId || data.data.grantId !== command.grantId || data.data.actorUserId !== session.userId
    || JSON.stringify(data.data.packetRef) !== JSON.stringify(command.packetRef) || data.data.stepId !== command.stepId || data.data.actorBindingHash !== command.actorBindingHash
    || data.data.grantVersion < command.expectedGrantVersion || command.disposition === 'QUESTION' && !data.data.questionId
    || command.disposition !== 'QUESTION' && (data.data.stepVersion === null || data.data.stepVersion <= command.expectedStepVersion!))
    throw Error('Buyer result unconfirmed');
  return data;
}
async function commandBody(request: Request): Promise<BuyerCommand> {
  const raw = await readKnowledgeJson(request, ['contractVersion', 'grantId', 'expectedGrantVersion', 'packetRef', 'actorBindingHash', 'stepId', 'expectedStepVersion', 'disposition', 'comment', 'idempotencyKey', 'correlationId'], 32768);
  const metadata = crmRequestMetadata(request, raw);
  if (raw.idempotencyKey !== metadata.idempotencyKey || raw.correlationId !== metadata.correlationId) denied(400);
  return advisoryBuyerCommandSchema.parse(raw);
}
/** A link grants only its narrow read. Native fresh account/grant admission happens again inside each store operation. */
export function createWebsiteSalesBuyerHttp(ports: WebsiteSalesBuyerHttpPorts) {
  const origin = () => ports.trustedOrigin ?? getTrustedAppOrigin();
  const admit = async (request: Request, writing: boolean) => {
    const validContext = writing ? validateCsrfRequestContext(request.headers, origin()) : validateCsrfIssuanceContext(request.headers, origin());
    if (!validContext.ok) denied();
    const token = readToken(request), session = await currentSession(request, ports);
    if (writing) {
      if (!session) denied(401);
      const csrf = await (ports.csrf ?? enforceCsrfForSession)(request, session!);
      if (!csrf.ok) throw new CrmCommandError('BUYER_CSRF_DENIED', 'Buyer request denied', csrf.response.status);
    }
    return { token, session };
  };
  return {
    async GET(request: Request) {
      try { const { token, session } = await admit(request, false); return json(safeRead(await ports.read(token, session), session)); }
      catch (error) { return failure(error); }
    },
    async POST(request: Request) {
      try {
        const { token, session } = await admit(request, true), command = await commandBody(request);
        const data = safeReceipt(await ports.confirm(session!, token, command), command, session!);
        return json(data);
      } catch (error) { return failure(error); }
    },
    async RECONCILE(request: Request) {
      try {
        const { token, session } = await admit(request, true), command = await commandBody(request);
        const parsed = advisoryBuyerReconcileSchema.safeParse(await ports.reconcile(session!, token, command));
        if (!parsed.success) throw Error('Buyer reconciliation unconfirmed');
        const data = parsed.data;
        if (data.correlationId !== command.correlationId) throw Error('Buyer result unconfirmed');
        if (data.status === 'COMMITTED') {
          safeRead(data.currentData, session);
          safeReceipt(data.receipt, command, session!);
          if (!data.receipt.replayed || data.currentData.grantId !== command.grantId || JSON.stringify(data.currentData.packetRef) !== JSON.stringify(command.packetRef))
            throw Error('Buyer result unconfirmed');
        }
        return json(data);
      } catch (error) { return failure(error); }
    },
    async ASSET(request: Request, assetId: string) {
      try {
        const { token, session } = await admit(request, false);
        z.uuid().parse(assetId);
        const data = await ports.asset(token, assetId, session);
        if (data.mediaType !== 'video/webm' || !data.bytes.byteLength || data.bytes.byteLength > 25_000_000
          || createHash('sha256').update(data.bytes).digest('hex') !== data.sha256) throw Error('Buyer asset unconfirmed');
        return new Response(new Uint8Array(data.bytes), { headers: { ...commonHeaders, 'Content-Type': 'video/webm',
          'Content-Length': String(data.bytes.byteLength), 'Content-Disposition': 'inline; filename="demo-explanation.webm"' } });
      } catch (error) { return failure(error); }
    },
  };
}
