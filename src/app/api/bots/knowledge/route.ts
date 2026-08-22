import { createKnowledgeChunks } from "@/lib/bots/rag";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { hasDatabaseUrl } from "@/lib/db/client";
import {
  insertKnowledgeSourceWithChunks,
  isKnowledgeProjectInWorkspace,
  isUuid,
  listKnowledgeSources,
  searchPersistedKnowledge,
} from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { embedText, getEmbeddingProviderStatus } from "@/lib/integrations/embeddings";

export const maxDuration = 60;

const knowledgeRequestLimits = Object.freeze({
  bodyBytes: 48 * 1024,
  chunks: 12,
  chunkCharacters: 2_800,
  contentCharacters: 32_000,
  embeddingConcurrency: 3,
  queryCharacters: 2_000,
  titleCharacters: 160,
});
const knowledgeSourceTypes = new Set(["call", "faq", "file", "social", "text", "url"]);
const knowledgeApprovals = new Set(["approved", "Freigegeben", "Nur intern", "review", "Zu prüfen"]);

class KnowledgeRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function readBoundedJson(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new KnowledgeRequestError("unsupported_content_type", 415);
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new KnowledgeRequestError("unsupported_content_encoding", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new KnowledgeRequestError("invalid_content_length", 400);
    }
    if (bytes > knowledgeRequestLimits.bodyBytes) {
      throw new KnowledgeRequestError("knowledge_source_too_large", 413);
    }
  }
  if (!request.body || request.bodyUsed) {
    throw new KnowledgeRequestError("invalid_json", 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > knowledgeRequestLimits.bodyBytes) {
      await reader.cancel("knowledge_source_too_large");
      throw new KnowledgeRequestError("knowledge_source_too_large", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new KnowledgeRequestError("invalid_json", 400);
  }
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  transform: (value: Input, index: number) => Promise<Output>,
) {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function hasKnowledgePersistence(workspaceId: string) {
  return hasDatabaseUrl() && isUuid(workspaceId);
}

function knowledgeUnavailable() {
  return Response.json(
    {
      error: "Knowledge persistence unavailable",
      persisted: false,
      source: "unavailable",
      sources: [],
    },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "knowledge:write", "knowledge:write");

  if (!auth.ok) return auth.response;
  if (!hasKnowledgePersistence(auth.session.workspaceId)) return knowledgeUnavailable();

  try {
    const url = new URL(request.url);
    const query = String(url.searchParams.get("query") ?? url.searchParams.get("q") ?? "").trim();
    if (query.length > knowledgeRequestLimits.queryCharacters) {
      return Response.json({ error: "Knowledge query is too long" }, { status: 413 });
    }
    const requestedLimit = Number(url.searchParams.get("limit") ?? 10);
    const limit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : 10)));

    if (query) {
      const provider = getEmbeddingProviderStatus();
      if (!provider.configured || !provider.external) return knowledgeUnavailable();
      const embedding = await embedText(query);
      if (!embedding.external) return knowledgeUnavailable();
      const results = await searchPersistedKnowledge({
        session: auth.session,
        query,
        embedding: embedding.embedding,
        limit,
      });

      return Response.json({
        source: "database",
        embeddingProvider: getEmbeddingProviderStatus(),
        query,
        results,
      });
    }

    const sources = await listKnowledgeSources({
      session: auth.session,
      limit,
    });

    return Response.json({
      source: "database",
      embeddingProvider: getEmbeddingProviderStatus(),
      sources,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "knowledge_read_failed",
        reason: error instanceof KnowledgeRequestError ? error.code : "unexpected_error",
      }),
    );
    return knowledgeUnavailable();
  }
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermissionAndProductCapability(request, "knowledge:write", "knowledge:write");

  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const status = error instanceof KnowledgeRequestError ? error.status : 400;
    const code = error instanceof KnowledgeRequestError ? error.code : copy.invalidJson;
    return Response.json({ error: code }, { status });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const title = String("title" in body ? body.title : "").trim();
  const contentOrLocation = String("contentOrLocation" in body ? body.contentOrLocation : "").trim();
  const sourceType = String("sourceType" in body ? body.sourceType : "text");
  const approval = String("approval" in body ? body.approval : "review");
  const requestedProjectId = "projectId" in body && typeof body.projectId === "string"
    ? body.projectId.trim()
    : null;

  if (!title || !contentOrLocation) {
    return Response.json({ error: copy.knowledgeSourceRequired }, { status: 400 });
  }
  if (
    title.length > knowledgeRequestLimits.titleCharacters ||
    contentOrLocation.length > knowledgeRequestLimits.contentCharacters
  ) {
    return Response.json({ error: "Knowledge source exceeds the allowed size" }, { status: 413 });
  }
  if (!knowledgeSourceTypes.has(sourceType) || !knowledgeApprovals.has(approval)) {
    return Response.json({ error: "Invalid knowledge source contract" }, { status: 400 });
  }
  if (requestedProjectId && !isUuid(requestedProjectId)) {
    return Response.json({ error: "Invalid project" }, { status: 400 });
  }
  if (!hasKnowledgePersistence(auth.session.workspaceId)) return knowledgeUnavailable();

  try {
    if (!(await isKnowledgeProjectInWorkspace({
      projectId: requestedProjectId,
      session: auth.session,
    }))) {
      return Response.json({ error: "Invalid project" }, { status: 400 });
    }
    const shouldEmbed = ["approved", "Freigegeben"].includes(approval);
    const embeddingProvider = getEmbeddingProviderStatus();
    if (shouldEmbed && (!embeddingProvider.configured || !embeddingProvider.external)) {
      return knowledgeUnavailable();
    }
    const draftSourceId = crypto.randomUUID();
    const chunks = createKnowledgeChunks({
      sourceId: draftSourceId,
      title,
      content: contentOrLocation,
      citationUrl: sourceType === "url" ? contentOrLocation : undefined,
      approved: shouldEmbed,
      chunkSize: knowledgeRequestLimits.chunkCharacters,
    });
    if (chunks.length > knowledgeRequestLimits.chunks) {
      return Response.json({ error: "Knowledge source creates too many chunks" }, { status: 413 });
    }
    const embeddedChunks = await mapWithConcurrency(
      chunks,
      knowledgeRequestLimits.embeddingConcurrency,
      async (chunk) => {
        if (!shouldEmbed) {
          return {
            ...chunk,
            embedding: undefined,
            embeddingExternal: false,
            embeddingModel: undefined,
            embeddingReason: undefined,
          };
        }

        const embedding = await embedText(`${chunk.citationTitle}\n${chunk.content}`);
        return {
          ...chunk,
          embedding: embedding.embedding,
          embeddingExternal: embedding.external,
          embeddingModel: embedding.model,
          embeddingReason: embedding.reason,
        };
      },
    );
    if (shouldEmbed && embeddedChunks.some((chunk) => !chunk.embeddingExternal)) {
      return knowledgeUnavailable();
    }
    const persistedSourceId = await insertKnowledgeSourceWithChunks({
      session: auth.session,
      projectId: requestedProjectId,
      title,
      sourceType,
      location: sourceType === "url" ? contentOrLocation : undefined,
      status: shouldEmbed ? "Vector bereit" : "Review offen",
      chunks: embeddedChunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        citationTitle: chunk.citationTitle,
        citationUrl: chunk.citationUrl,
        embedding: chunk.embedding,
        embeddingModel: chunk.embeddingModel,
      })),
      metadata: { approval },
    });

    if (!persistedSourceId) return knowledgeUnavailable();

    return Response.json({
      sourceId: persistedSourceId,
      status: shouldEmbed ? "synced" : "review_required",
      approval,
      embeddingProvider: getEmbeddingProviderStatus(),
      chunkCount: chunks.length,
      embeddedChunkCount: shouldEmbed ? chunks.length : 0,
      persisted: true,
      chunks: embeddedChunks.map((chunk) => ({
        id: chunk.id,
        sourceId: persistedSourceId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        citationTitle: chunk.citationTitle,
        citationUrl: chunk.citationUrl,
        embeddingReady: chunk.embeddingReady,
        embeddingModel: chunk.embeddingModel,
        embeddingReason: chunk.embeddingReason,
      })),
      previewResults: [],
      pipeline: ["import", "clean", "chunk", shouldEmbed ? "embed" : "review", "cite"],
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "knowledge_import_failed",
        reason: error instanceof KnowledgeRequestError ? error.code : "unexpected_error",
      }),
    );
    return knowledgeUnavailable();
  }
}
