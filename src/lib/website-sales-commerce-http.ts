import { ZodError } from 'zod';
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from './crm-command';
import { readKnowledgeJson } from './knowledge-center/http';
import { KnowledgeCenterError } from './knowledge-center/policy';
import { parseWebsiteSalesCommerceCommand } from './db/website-sales-commerce-repositories';
export async function websiteSalesCommerceBody(request: Request) {
 const raw = await readKnowledgeJson(request, ['contractVersion','operation','projectId','companyId','locationId','workflowId','expectedVersion','expectedWorkflowVersion','idempotencyKey','correlationId','payload'], 131072);
 const metadata = crmRequestMetadata(request, raw);
 if (raw.idempotencyKey !== metadata.idempotencyKey || raw.correlationId !== metadata.correlationId) throw new CrmCommandError('METADATA_MISMATCH','Exact original metadata required');
 return parseWebsiteSalesCommerceCommand(raw);
}
export function websiteSalesCommerceError(error: unknown) {
 if (error instanceof KnowledgeCenterError) return Response.json({code:error.code},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
 return crmCommandErrorResponse(error instanceof ZodError ? new CrmCommandError('INVALID_COMMERCE_PAYLOAD','Invalid commerce payload',400) : error);
}
