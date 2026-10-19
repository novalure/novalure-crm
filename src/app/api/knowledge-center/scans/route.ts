import { getKnowledgeScanSource, revalidateKnowledgeScanSource, updateKnowledgeSource } from "@/lib/knowledge-center/repository";
import { scanWebsite, WebsiteScanError } from "@/lib/knowledge-center/website-scanner";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["sourceId", "expectedVersion"]);
    const expectedVersion = knowledgeRevision(body.expectedVersion);
    const previous = await getKnowledgeScanSource(session, { sourceId: knowledgeId(body.sourceId, "sourceId"), expectedVersion });
    if (previous.revision !== expectedVersion) throw new KnowledgeCenterError("VERSION_CONFLICT", "Knowledge source changed; reload before scanning.", 409);
    let scanned;
    try { scanned = await scanWebsite(previous.url, { previousHash: previous.contentHash }); }
    catch (error) {
      if (error instanceof WebsiteScanError) throw new KnowledgeCenterError(error.code, "The website could not be safely scanned.", error.code === "website_scan_timeout" ? 504 : 422);
      throw error;
    }
    const scan = { change: scanned.change, title: scanned.title, finalUrl: scanned.finalUrl, scannedAt: scanned.scannedAt, trust: scanned.trust };
    await revalidateKnowledgeScanSource(session, { sourceId: previous.sourceId, expectedVersion });
    if (scanned.change.kind === "unchanged") return knowledgeJson({ scan, unchanged: true });
    // Revalidates current membership, entitlement, project rights and revision
    // after the external fetch. Fetched website text is always an unapproved draft.
    const source = await updateKnowledgeSource(session, { sourceId: previous.sourceId, expectedVersion, content: scanned.text });
    return knowledgeJson({ source, version: source.version, scan, unchanged: false }, 201);
  });
}
