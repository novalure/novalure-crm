"use client";

import DOMPurify from "dompurify";
import { useSyncExternalStore } from "react";
const subscribe = () => () => undefined;
const client = () => true, server = () => false;

/** The server and first hydration show inert text; authored HTML is sanitized in the browser. */
export function FunnelSafeContent({ value, className, inline = false }: { value?: string; className?: string; inline?: boolean }) {
  const hydrated = useSyncExternalStore(subscribe, client, server), content = value ?? "";
  const Tag = inline ? "span" : "div";
  if (!hydrated || !content.includes("<")) return <Tag className={className}>{content.replace(/<[^>]*>/g, "")}</Tag>;
  const html = DOMPurify.sanitize(content, { ALLOWED_TAGS: ["p", "br", "span", "strong", "b", "em", "i", "u", "s", "h1", "h2", "h3", "h4", "ul", "ol", "li", "a", "blockquote", "table", "thead", "tbody", "tr", "th", "td"], ALLOWED_ATTR: ["href", "title", "colspan", "rowspan"], ALLOW_DATA_ATTR: false });
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
