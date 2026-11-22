import { ZodError } from 'zod';
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from './crm-command';
import { readKnowledgeJson } from './knowledge-center/http';
import { KnowledgeCenterError } from './knowledge-center/policy';
import { parseWebsiteSalesEnablementCommand } from './db/website-sales-enablement-repositories';
export async function websiteSalesEnablementBody(request: Request) {
 const raw = await readKnowledgeJson(request, ['contractVersion', 'operation', 'projectId', 'companyId', 'locationId', 'expectedVersion', 'expectedWorkflowVersion', 'idempotencyKey', 'correlationId', 'payload'], 131072);
 const meta = crmRequestMetadata(request, raw);
 if (raw.idempotencyKey !== meta.idempotencyKey || raw.correlationId !== meta.correlationId) throw new CrmCommandError('METADATA_MISMATCH', 'Exact original metadata required');
 return parseWebsiteSalesEnablementCommand(raw);
}
export function websiteSalesEnablementError(error: unknown) {
 if (error instanceof KnowledgeCenterError) return Response.json({ code: error.code }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
 return crmCommandErrorResponse(error instanceof ZodError ? new CrmCommandError('INVALID_ENABLEMENT_PAYLOAD', 'Invalid enablement payload', 400) : error);
}
