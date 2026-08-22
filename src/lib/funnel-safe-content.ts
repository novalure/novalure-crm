const blockedContainerPattern = /<\s*(script|style|svg|math|template|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const commentPattern = /<!--[\s\S]*?(?:-->|$)/g;
const lineBreakPattern = /<\s*br\b[^>]*>/gi;
const listItemStartPattern = /<\s*li\b[^>]*>/gi;
const blockBoundaryPattern = /<\s*\/?\s*(?:address|article|aside|blockquote|div|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;
const remainingTagPattern = /<[^>]*>/g;
const entityPattern = /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi;

const namedEntities: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  bull: "•",
  cent: "¢",
  copy: "©",
  emsp: " ",
  ensp: " ",
  euro: "€",
  gt: ">",
  hellip: "…",
  laquo: "«",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  newline: "\n",
  pound: "£",
  quot: '"',
  raquo: "»",
  reg: "®",
  tab: "\t",
  yen: "¥",
});

function decodeCodePoint(value: number) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "�";
  }

  return String.fromCodePoint(value);
}

function decodeEntities(value: string) {
  return value.replace(entityPattern, (entity, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized.startsWith("#x")) return decodeCodePoint(Number.parseInt(normalized.slice(2), 16));
    if (normalized.startsWith("#")) return decodeCodePoint(Number.parseInt(normalized.slice(1), 10));
    return namedEntities[normalized] ?? entity;
  });
}

/**
 * Converts stored funnel markup to deterministic plain text. The returned value
 * must be rendered as a normal React text child; it is never trusted HTML.
 */
export function toSafeFunnelText(value: string | null | undefined) {
  if (!value) return "";

  const withoutExecutableContainers = value
    .replace(/\r\n?/g, "\n")
    .replace(commentPattern, "")
    .replace(blockedContainerPattern, "")
    .replace(lineBreakPattern, "\n")
    .replace(listItemStartPattern, "\n• ")
    .replace(blockBoundaryPattern, "\n")
    .replace(remainingTagPattern, "");

  return decodeEntities(withoutExecutableContainers)
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
