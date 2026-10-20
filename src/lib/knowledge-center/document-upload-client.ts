"use client";

import { csrfFetch } from "@/lib/security/csrf-client";
import { finalizeAfterPrivateDocumentUpload } from "./document-upload-transport";

type DocumentTarget = { areaId: string; name: string; sourceId?: string; expectedVersion?: number };

/** The file goes directly to the private provider. Only metadata, a scoped
 * capability and finalization cross the hosting platform's request body limit. */
export async function uploadKnowledgeDocument(endpoint: string, file: File, target: DocumentTarget): Promise<Response> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const prepared = await csrfFetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare", ...target, fileName: file.name, mimeType: file.type, sizeBytes: file.size, sha256 }),
  });
  if (!prepared.ok) return prepared;
  const grant = await prepared.json() as { transport?: string; pathname?: string; clientToken?: string; ticket?: string; result?: unknown };
  if (grant.transport === "completed" && grant.result) return Response.json(grant.result);
  if (grant.transport === "multipart") {
    const body = new FormData();
    body.append("file", file); body.append("name", target.name); body.append("areaId", target.areaId);
    if (target.sourceId) { body.append("sourceId", target.sourceId); body.append("expectedVersion", String(target.expectedVersion)); }
    return csrfFetch(endpoint, { method: "POST", body });
  }
  if (grant.transport !== "private-blob" || !grant.pathname || !grant.clientToken || !grant.ticket) throw new Error("Private document upload authorization is unavailable.");
  const { pathname, clientToken, ticket } = grant;
  return finalizeAfterPrivateDocumentUpload(async (signal) => {
    const { put } = await import("@vercel/blob/client");
    signal.throwIfAborted();
    await put(pathname, file, { access: "private", token: clientToken, contentType: file.type, abortSignal: signal });
  }, () => csrfFetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "finalize", ticket }),
  }));
}
