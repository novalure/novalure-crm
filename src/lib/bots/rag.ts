import type { RagKnowledgeChunk, RagSearchResult } from "@/lib/crm-types";

export function normalizeWhitespace(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(normalizeWhitespace(value).length / 4));
}

export function createKnowledgeChunks(input: {
  sourceId: string;
  title: string;
  content: string;
  citationUrl?: string;
  approved: boolean;
  chunkSize?: number;
}): RagKnowledgeChunk[] {
  const chunkSize = input.chunkSize || 700;
  const normalized = normalizeWhitespace(input.content);
  const chunks: RagKnowledgeChunk[] = [];

  for (let index = 0; index < normalized.length; index += chunkSize) {
    const content = normalized.slice(index, index + chunkSize).trim();
    if (!content) continue;

    chunks.push({
      id: `${input.sourceId}-chunk-${chunks.length}`,
      sourceId: input.sourceId,
      chunkIndex: chunks.length,
      content,
      tokenCount: estimateTokens(content),
      citationTitle: input.title,
      citationUrl: input.citationUrl,
      embeddingReady: input.approved,
    });
  }

  if (chunks.length > 0) {
    return chunks;
  }

  return [
    {
      id: `${input.sourceId}-chunk-0`,
      sourceId: input.sourceId,
      chunkIndex: 0,
      content: input.title,
      tokenCount: estimateTokens(input.title),
      citationTitle: input.title,
      citationUrl: input.citationUrl,
      embeddingReady: input.approved,
    },
  ];
}

export function searchKnowledgeChunks(query: string, chunks: RagKnowledgeChunk[]): RagSearchResult[] {
  const terms = normalizeWhitespace(query).toLowerCase().split(" ").filter(Boolean);

  return chunks
    .map((chunk) => {
      const haystack = `${chunk.citationTitle} ${chunk.content}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      const score = terms.length ? hits / terms.length : 0;

      return {
        chunkId: chunk.id,
        title: chunk.citationTitle,
        excerpt: chunk.content.slice(0, 240),
        citationUrl: chunk.citationUrl,
        score: Number(score.toFixed(2)),
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
