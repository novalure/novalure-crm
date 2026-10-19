import { maxMediaUploadBytes, MediaStoreError } from "@/lib/media-store";
import { assertKnowledgeUploadAllowed, importKnowledgeDocument } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeBytes, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, knowledgeText } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    await assertKnowledgeUploadAllowed(session, { sizeBytes: 0 });
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new KnowledgeCenterError("FORM_REQUIRED", "A multipart document upload is required.", 415);
    const bytes = await readKnowledgeBytes(request, maxMediaUploadBytes + 64 * 1024);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "content-type": contentType } }).formData(); }
    catch { throw new KnowledgeCenterError("INVALID_FORM", "Invalid document upload form."); }
    for (const key of form.keys()) {
      if (!["file", "name", "alt", "areaId", "sourceId", "expectedVersion"].includes(key) || form.getAll(key).length !== 1) throw new KnowledgeCenterError("UNKNOWN_FIELD", "Unknown or duplicate document form field.");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) throw new KnowledgeCenterError("DOCUMENT_REQUIRED", "A nonempty document file is required.");
    if (file.size > maxMediaUploadBytes) throw new KnowledgeCenterError("PAYLOAD_TOO_LARGE", "Documents must be 10 MB or smaller.", 413);
    const name = form.has("name") ? knowledgeText(form.get("name"), "name", 200) : undefined;
    const alt = form.has("alt") ? knowledgeText(form.get("alt"), "alt", 1000, false) : undefined;
    const areaId = knowledgeId(form.get("areaId"), "areaId");
    const sourceId = form.has("sourceId") ? knowledgeId(form.get("sourceId"), "sourceId") : undefined;
    const rawVersion = form.get("expectedVersion");
    if (rawVersion !== null && (typeof rawVersion !== "string" || !/^[1-9]\d*$/.test(rawVersion))) throw new KnowledgeCenterError("VERSION_REQUIRED", "A current expectedVersion is required.", 409);
    const expectedVersion = rawVersion === null ? undefined : knowledgeRevision(Number(rawVersion));
    try {
      const result = await importKnowledgeDocument(session, { file, name, alt, areaId, sourceId, expectedVersion });
      // Generic media paths never receive a storage locator for knowledge documents.
      return knowledgeJson(result, result.reused ? 200 : 201);
    } catch (error) {
      if (error instanceof MediaStoreError) {
        const status = error.code.endsWith("STORAGE_UNAVAILABLE") ? 503 : error.code === "WORKSPACE_QUOTA_EXCEEDED" ? 409 : error.code === "FILE_TOO_LARGE" ? 413 : 415;
        throw new KnowledgeCenterError(error.code, status === 503 ? "Document storage is temporarily unavailable." : "Document upload was rejected.", status);
      }
      throw error;
    }
  });
}
