import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import {
  createManagedWebsiteIntegration,
  listManagedWebsiteIntegrations,
  updateManagedWebsiteIntegration,
  websiteIntegrationCreateFields,
  websiteIntegrationUpdateFields,
} from "@/lib/integrations/website-integration-management";

export async function GET(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    return knowledgeJson(await listManagedWebsiteIntegrations(session));
  });
}

export async function POST(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, websiteIntegrationCreateFields, 32_768);
    const integration = await createManagedWebsiteIntegration(session, body);
    return knowledgeJson({ integration, status: integration.status }, 201);
  });
}

export async function PATCH(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, websiteIntegrationUpdateFields, 32_768);
    return knowledgeJson({ integration: await updateManagedWebsiteIntegration(session, body) });
  });
}
