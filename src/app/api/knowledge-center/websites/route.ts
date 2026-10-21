import { assertKnowledgeFields, knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, knowledgeText, knowledgeUrl } from "@/lib/knowledge-center/policy";
import { createKnowledgeWebsiteImport, importInitialKnowledgeWebsite } from "@/lib/knowledge-center/website-import";

export const runtime = "nodejs";
export const maxDuration = 60;

/** A normal authenticated import request creates a readable draft, never a publication. */
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["action", "areaId", "name", "url", "sourceId", "expectedVersion"], 4096);
    if (body.action === "create") {
      assertKnowledgeFields(body, ["action", "areaId", "name", "url"]);
      const url = knowledgeUrl(body.url);
      if (!url) throw new KnowledgeCenterError("VALIDATION_ERROR", "A public website URL is required.");
      const result = await createKnowledgeWebsiteImport(session, {
        areaId: knowledgeId(body.areaId, "areaId"),
        name: knowledgeText(body.name, "name", 200),
        url,
      });
      return knowledgeJson(result, 201);
    }
    if (body.action === "import") {
      assertKnowledgeFields(body, ["action", "sourceId", "expectedVersion"]);
      return knowledgeJson(await importInitialKnowledgeWebsite(session, {
        sourceId: knowledgeId(body.sourceId, "sourceId"),
        expectedVersion: knowledgeRevision(body.expectedVersion),
      }));
    }
    throw new KnowledgeCenterError("VALIDATION_ERROR", "A website import action is required.");
  });
}
