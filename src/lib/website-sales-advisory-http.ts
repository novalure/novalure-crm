import { ZodError } from 'zod';
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from './crm-command';
import { readKnowledgeJson } from './knowledge-center/http';
import { KnowledgeCenterError } from './knowledge-center/policy';
import { parseWebsiteSalesAdvisoryCommand } from './db/website-sales-advisory-repositories';

export async function websiteSalesAdvisoryBody(request: Request) {
 const raw = await readKnowledgeJson(request, ['contractVersion', 'operation', 'projectId', 'companyId', 'locationId', 'workflowId', 'expectedVersion', 'expectedWorkflowVersion', 'idempotencyKey', 'correlationId', 'payload'], 131072);
 const meta = crmRequestMetadata(request, raw);
 if (raw.idempotencyKey !== meta.idempotencyKey || raw.correlationId !== meta.correlationId) throw new CrmCommandError('METADATA_MISMATCH', 'Exact original metadata required');
 return parseWebsiteSalesAdvisoryCommand(raw);
}
export function websiteSalesAdvisoryError(error: unknown) {
 if (error instanceof KnowledgeCenterError) return Response.json({ code: error.code }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
 return crmCommandErrorResponse(error instanceof ZodError ? new CrmCommandError('INVALID_ADVISORY_PAYLOAD', 'Invalid advisory payload', 400) : error);
}
