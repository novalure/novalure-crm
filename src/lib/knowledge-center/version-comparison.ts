import type { KnowledgeVersion } from "./types";

export type KnowledgeVersionDifference = { field: string; before: string; after: string };

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalValue(entry)]));
  return value;
}
function stableValue(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(canonicalValue(value), null, 2);
}

export function compareKnowledgeVersions(before: KnowledgeVersion, after: KnowledgeVersion): KnowledgeVersionDifference[] {
  const fields: KnowledgeVersionDifference[] = [
    { field: "name", before: before.name, after: after.name },
    { field: "content", before: before.content, after: after.content },
    { field: "url", before: before.url ?? "", after: after.url ?? "" },
    { field: "mediaAssetId", before: before.mediaAssetId ?? "", after: after.mediaAssetId ?? "" },
  ];
  const structuredKeys = new Set([...Object.keys(before.structuredData), ...Object.keys(after.structuredData)]);
  for (const key of structuredKeys) fields.push({ field: `structured.${key}`, before: stableValue(before.structuredData[key]), after: stableValue(after.structuredData[key]) });
  return fields.filter((field) => field.before !== field.after);
}
