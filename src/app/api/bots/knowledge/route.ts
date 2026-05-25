import { createKnowledgeChunks, searchKnowledgeChunks } from "@/lib/bots/rag";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  insertKnowledgeSourceWithChunks,
  listKnowledgeSources,
  searchPersistedKnowledge,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { embedText, getEmbeddingProviderStatus } from "@/lib/integrations/embeddings";

export const maxDuration = 60;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "knowledge:write", "knowledge:write");

  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const query = String(url.searchParams.get("query") ?? url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));

  if (query) {
    const embedding = await embedText(query);
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
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermissionAndProductCapability(request, "knowledge:write", "knowledge:write");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const title = String("title" in body ? body.title : "").trim();
  const contentOrLocation = String("contentOrLocation" in body ? body.contentOrLocation : "").trim();
  const sourceType = String("sourceType" in body ? body.sourceType : "text");
  const approval = String("approval" in body ? body.approval : "review");

  if (!title || !contentOrLocation) {
    return Response.json({ error: copy.knowledgeSourceRequired }, { status: 400 });
  }

  const shouldEmbed = ["approved", "Freigegeben"].includes(approval);
  const sourceId = crypto.randomUUID();
  const chunks = createKnowledgeChunks({
    sourceId,
    title,
    content: contentOrLocation,
    citationUrl: sourceType === "url" ? contentOrLocation : undefined,
    approved: shouldEmbed,
  });
  const embeddedChunks = await Promise.all(
    chunks.map(async (chunk) => {
      if (!shouldEmbed) {
        return { ...chunk, embedding: undefined, embeddingModel: undefined, embeddingReason: undefined };
      }

      const embedding = await embedText(`${chunk.citationTitle}\n${chunk.content}`);
      return {
        ...chunk,
        embedding: embedding.embedding,
        embeddingModel: embedding.model,
        embeddingReason: embedding.reason,
      };
    }),
  );
  const persistedSourceId = await insertKnowledgeSourceWithChunks({
    session: auth.session,
    projectId: "projectId" in body && typeof body.projectId === "string" ? body.projectId : null,
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
    metadata: { approval, sourceId },
  });
  const queryEmbedding = shouldEmbed ? await embedText(title) : null;
  const persistedPreviewResults =
    persistedSourceId && queryEmbedding
      ? await searchPersistedKnowledge({
          session: auth.session,
          query: title,
          embedding: queryEmbedding.embedding,
          limit: 5,
        })
      : [];

  await writeAuditLog({
    session: auth.session,
    action: shouldEmbed ? "knowledge.source.embedded" : "knowledge.source.review_queued",
    entityType: "knowledge_source",
    entityId: persistedSourceId,
    after: { title, sourceType, chunkCount: chunks.length, approval },
  });

  return Response.json({
    sourceId: persistedSourceId ?? sourceId,
    status: shouldEmbed ? "synced" : "review_required",
    approval,
    embeddingProvider: getEmbeddingProviderStatus(),
    chunkCount: chunks.length,
    embeddedChunkCount: shouldEmbed ? chunks.length : 0,
    persisted: Boolean(persistedSourceId),
    chunks: embeddedChunks.map((chunk) => ({
      id: chunk.id,
      sourceId: chunk.sourceId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      citationTitle: chunk.citationTitle,
      citationUrl: chunk.citationUrl,
      embeddingReady: chunk.embeddingReady,
      embeddingModel: chunk.embeddingModel,
      embeddingReason: chunk.embeddingReason,
    })),
    previewResults: persistedPreviewResults.length ? persistedPreviewResults : searchKnowledgeChunks(title, chunks),
    pipeline: ["import", "clean", "chunk", shouldEmbed ? "embed" : "review", "cite"],
  });
}
