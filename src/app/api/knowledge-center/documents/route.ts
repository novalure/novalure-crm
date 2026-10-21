import { getPrivateMediaBlobToken, maxMediaUploadBytes, MediaStoreError } from "@/lib/media-store";
import { assertKnowledgeDocumentUploadAllowed, assertKnowledgeUploadAllowed, expiredKnowledgeDocumentUploads, findKnowledgeDocumentImport, importKnowledgeDocument, releaseKnowledgeDocumentUpload, reserveKnowledgeDocumentUpload } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeBytes, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, knowledgeText } from "@/lib/knowledge-center/policy";
import { createKnowledgeDocumentUploadTicket, discardExpiredKnowledgeDocumentUpload, knowledgeDocumentUploadStoreFingerprint, parseKnowledgeDocumentUploadMetadata, readKnowledgeDocumentUpload, verifyKnowledgeDocumentUploadTicket } from "@/lib/knowledge-center/document-upload";

export const runtime = "nodejs";
export const maxDuration = 120;

async function cleanupExpiredUploads(session: Parameters<typeof expiredKnowledgeDocumentUploads>[0]) {
  const expired = await expiredKnowledgeDocumentUploads(session);
  for (const upload of expired) {
    // Retain the durable reservation if private storage deletion fails.
    await releaseKnowledgeDocumentUpload(session, upload.uploadId, {}, (pending) => discardExpiredKnowledgeDocumentUpload(session, pending));
  }
  return expired.length;
}
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.split(";", 1)[0].trim().toLowerCase() === "application/json") {
      const body = await readKnowledgeJson(request, ["action", "ticket", "areaId", "name", "alt", "sourceId", "expectedVersion", "fileName", "mimeType", "sizeBytes", "sha256"], 16 * 1024);
      if (body.action === "cleanup" && Object.keys(body).length === 1) return knowledgeJson({ cleaned: await cleanupExpiredUploads(session) });
      if (body.action === "prepare") {
        if (body.ticket !== undefined) throw new KnowledgeCenterError("UNKNOWN_FIELD", "A preparation request cannot include a ticket.");
        const metadata = parseKnowledgeDocumentUploadMetadata(body);
        const completed = await findKnowledgeDocumentImport(session, metadata);
        if (completed) return knowledgeJson({ transport: "completed", result: completed });
        await assertKnowledgeDocumentUploadAllowed(session, metadata);
        if (!getPrivateMediaBlobToken() && process.env.VERCEL !== "1") return knowledgeJson({ transport: "multipart" });
        await cleanupExpiredUploads(session);
        const grant = await createKnowledgeDocumentUploadTicket(session, metadata);
        const upload = verifyKnowledgeDocumentUploadTicket(session, grant.ticket);
        await reserveKnowledgeDocumentUpload(session, upload, knowledgeDocumentUploadStoreFingerprint());
        return knowledgeJson({ transport: "private-blob", ...grant });
      }
      if (body.action !== "finalize" || Object.keys(body).some((key) => !["action", "ticket"].includes(key))) throw new KnowledgeCenterError("UNKNOWN_FIELD", "Invalid document upload action or fields.");
      const upload = verifyKnowledgeDocumentUploadTicket(session, body.ticket);
      const repeated = await findKnowledgeDocumentImport(session, upload.metadata);
      if (repeated) return knowledgeJson(repeated);
      try { await assertKnowledgeDocumentUploadAllowed(session, upload.metadata); }
      catch (error) {
        // Keep exact-byte replay idempotent if another finalize committed after
        // the first receipt lookup but before this current-revision check.
        const completed = await findKnowledgeDocumentImport(session, upload.metadata);
        if (completed) return knowledgeJson(completed);
        throw error;
      }
      let file: File;
      try { file = await readKnowledgeDocumentUpload(upload); }
      catch (error) {
        // A concurrent successful finalizer may already have removed staging.
        const completed = await findKnowledgeDocumentImport(session, upload.metadata);
        if (completed) return knowledgeJson(completed);
        throw error;
      }
      const result = await importKnowledgeDocument(session, { ...upload.metadata, file, uploadReservationId: upload.uploadId });
      // Keep staging reserved until its provider grant expires. Deleting now
      // would let the still-valid token recreate an unaccounted object.
      return knowledgeJson(result, result.reused ? 200 : 201);
    }
    await assertKnowledgeUploadAllowed(session, { sizeBytes: 0 });
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
