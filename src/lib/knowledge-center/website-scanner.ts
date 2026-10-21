import "server-only";

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export class WebsiteScanError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WebsiteScanError";
  }
}

export type WebsiteScanAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type WebsiteScanResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}>;
export type WebsiteScanPorts = Readonly<{
  resolve(hostname: string, signal: AbortSignal): Promise<readonly WebsiteScanAddress[]>;
  /** Implementations must connect only to the supplied, already validated address. */
  request(input: Readonly<{
    url: URL;
    address: WebsiteScanAddress;
    signal: AbortSignal;
    maxBytes: number;
  }>): Promise<WebsiteScanResponse>;
}>;
export type WebsiteScanLimits = Readonly<{
  timeoutMs: number;
  maxBytes: number;
  maxTextCharacters: number;
  maxRedirects: number;
}>;
export type WebsiteScanResult = Readonly<{
  requestedUrl: string;
  finalUrl: string;
  title: string;
  text: string;
  contentHash: string;
  scannedAt: string;
  trust: "untrusted_external_content";
  change: Readonly<{
    kind: "initial" | "changed" | "unchanged";
    requiresApproval: true;
    previousHash: string | null;
    proposedHash: string;
  }>;
}>;

const defaultLimits: WebsiteScanLimits = {
  timeoutMs: 8_000,
  maxBytes: 1_000_000,
  maxTextCharacters: 100_000,
  maxRedirects: 3,
};

function ipv4Number(address: string) {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function ipv6Words(address: string): number[] {
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const tail = ipv4Number(value.slice(lastColon + 1));
    value = `${value.slice(0, lastColon)}:${Math.floor(tail / 65_536).toString(16)}:${(tail % 65_536).toString(16)}`;
  }
  const [left, right] = value.split("::");
  const start = left ? left.split(":").map((word) => parseInt(word, 16)) : [];
  const end = right ? right.split(":").map((word) => parseInt(word, 16)) : [];
  return right !== undefined
    ? [...start, ...Array<number>(8 - start.length - end.length).fill(0), ...end]
    : start;
}

/** Fail closed for special-use, transition, mapped, private and reserved networks. */
export function isPublicIpAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const denied: readonly [string, number][] = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
      ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !denied.some(([network, bits]) => {
      const size = 2 ** (32 - bits);
      return Math.floor(value / size) === Math.floor(ipv4Number(network) / size);
    });
  }
  if (family !== 6 || address.includes("%")) return false;
  const words = ipv6Words(address);
  // Only global unicast; all mapped/compatible IPv4, NAT64, ULA and local ranges fail.
  if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
  if (words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) return false;
  if (words[0] === 0x2002 || (words[0] === 0x3fff && words[1] <= 0x0fff)) return false;
  return true;
}

export function validateWebsiteUrl(input: string): URL {
  if (typeof input !== "string" || input.length > 2_048 || /[\u0000-\u0020\u007f]/u.test(input)) {
    throw new WebsiteScanError("website_url_invalid");
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new WebsiteScanError("website_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new WebsiteScanError("website_url_denied");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new WebsiteScanError("website_address_denied");
  } else if (
    hostname.length > 253 || !hostname.includes(".") ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion|home|lan|intranet)$/u.test(hostname)
  ) {
    throw new WebsiteScanError("website_hostname_denied");
  }
  url.hash = "";
  return url;
}

function sameIpAddress(left: string, right: string) {
  const normalize = (address: string) => {
    const clean = address.replace(/^\[|\]$/g, "");
    return isIP(clean) === 6 ? ipv6Words(clean).join(":") : clean;
  };
  return normalize(left) === normalize(right);
}

const nodePorts: WebsiteScanPorts = {
  async resolve(hostname) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  },
  async request({ url, address, signal, maxBytes }) {
    return new Promise((resolve, reject) => {
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const request = httpsRequest(url, {
        method: "GET",
        signal,
        agent: false,
        // Explicit family also disables Node's dual-stack auto selection.
        family: address.family,
        maxHeaderSize: 16_384,
        servername: isIP(hostname) ? "" : hostname,
        // Never perform a second DNS resolution between validation and connection.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: {
          Accept: "text/html,text/plain;q=0.9",
          "Accept-Encoding": "identity",
          "User-Agent": "Novalure-Knowledge-Scanner/1.0",
        },
      }, (response) => {
        response.on("error", reject);
        const fail = (code: string) => {
          const error = new WebsiteScanError(code);
          response.destroy(error);
          request.destroy(error);
          reject(error);
        };
        const remote = response.socket.remoteAddress;
        if (!remote || !sameIpAddress(remote, address.address)) return fail("website_connection_address_mismatch");
        const status = response.statusCode ?? 0;
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key] = Array.isArray(value) ? value.join(",") : value;
        }
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          resolve({ status, headers, body: new Uint8Array() });
          return;
        }
        if (status < 200 || status >= 300) return fail("website_http_error");
        if (!/^(?:text\/html|text\/plain)(?:\s*;|\s*$)/iu.test(headers["content-type"] ?? "")) {
          return fail("website_content_type_denied");
        }
        if (headers["content-encoding"] && headers["content-encoding"].toLowerCase() !== "identity") {
          return fail("website_encoding_denied");
        }
        const declaredLength = headers["content-length"];
        if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
          return fail("website_response_too_large");
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("aborted", () => reject(new WebsiteScanError("website_response_aborted")));
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxBytes) return fail("website_response_too_large");
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks, length) }));
      });
      request.on("error", reject);
      request.end();
    });
  },
};

function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (match, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? match;
    const point = entity.toLowerCase().startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : " ";
  });
}

function normalizeText(value: string) {
  return decodeEntities(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

/** Extracts inert text only: no scripts, links, tools, models or remote instructions execute. */
export function extractWebsiteText(html: string, plainText = false) {
  if (plainText) return { title: "", text: normalizeText(html) };
  // Advance monotonically rather than applying unbounded tag regexes to malformed
  // HTML (a long sequence of unmatched '<' must not cause quadratic CPU work).
  const lower = html.toLowerCase(), body: string[] = [], titles: string[] = [];
  let offset = 0, inHead = false, inTitle = false;
  const append = (value: string) => {
    if (inTitle) titles.push(value);
    else if (!inHead) body.push(value);
  };
  while (offset < html.length) {
    const opening = html.indexOf("<", offset);
    if (opening < 0) { append(html.slice(offset)); break; }
    append(html.slice(offset, opening));
    if (lower.startsWith("<!--", opening)) {
      const end = lower.indexOf("-->", opening + 4);
      offset = end < 0 ? html.length : end + 3;
      append(" ");
      continue;
    }
    const end = html.indexOf(">", opening + 1);
    if (end < 0) { append(html.slice(opening)); break; }
    const token = html.slice(opening + 1, end).trimStart().match(/^(\/?)\s*([a-z][a-z0-9:-]*)\b/iu);
    offset = end + 1;
    append(" ");
    if (!token) continue;
    const closing = token[1] === "/", name = token[2].toLowerCase();
    if (name === "head") inHead = !closing;
    if (name === "title") inTitle = !closing;
    if (!closing && ["script", "style", "noscript", "iframe", "svg", "template"].includes(name)) {
      const close = lower.indexOf(`</${name}`, offset);
      if (close < 0) break;
      const closeEnd = html.indexOf(">", close);
      offset = closeEnd < 0 ? html.length : closeEnd + 1;
    }
  }
  return { title: normalizeText(titles.join(" ")).slice(0, 300), text: normalizeText(body.join(" ")) };
}

function scanLimits(input: Partial<WebsiteScanLimits> = {}): WebsiteScanLimits {
  const limits = { ...defaultLimits, ...input };
  for (const [key, maximum] of Object.entries({ timeoutMs: 15_000, maxBytes: 2_000_000, maxTextCharacters: 200_000, maxRedirects: 5 })) {
    const value = limits[key as keyof WebsiteScanLimits];
    if (!Number.isSafeInteger(value) || value < (key === "maxRedirects" ? 0 : 1) || value > maximum) {
      throw new WebsiteScanError("website_scan_limits_invalid");
    }
  }
  return limits;
}

/** Caller must authorize tenant/source access before this server-only network operation. */
export async function scanWebsite(input: string, options: Readonly<{
  ports?: WebsiteScanPorts;
  limits?: Partial<WebsiteScanLimits>;
  previousHash?: string | null;
}> = {}): Promise<WebsiteScanResult> {
  const requested = validateWebsiteUrl(input);
  const limits = scanLimits(options.limits);
  const ports = options.ports ?? nodePorts;
  const controller = new AbortController();
  let rejectTimeout: (reason: unknown) => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  // One deadline includes DNS, connection, redirects and the entire response body.
  const timer = setTimeout(() => {
    const error = new WebsiteScanError("website_scan_timeout");
    controller.abort(error);
    rejectTimeout(error);
  }, limits.timeoutMs);
  try {
    return await Promise.race([(async () => {
      let url = requested;
      for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
        if (controller.signal.aborted) throw new WebsiteScanError("website_scan_timeout");
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const family = isIP(hostname);
        const addresses = family
          ? [{ address: hostname, family: family as 4 | 6 }]
          : await ports.resolve(hostname, controller.signal);
        if (!addresses.length || addresses.length > 32 || addresses.some((address) =>
          !isPublicIpAddress(address.address) || isIP(address.address) !== address.family)) {
          throw new WebsiteScanError("website_address_denied");
        }
        if (controller.signal.aborted) throw new WebsiteScanError("website_scan_timeout");
        const response = await ports.request({ url, address: addresses[0], signal: controller.signal, maxBytes: limits.maxBytes });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (hop === limits.maxRedirects) throw new WebsiteScanError("website_redirect_limit");
          const location = response.headers.location;
          if (!location) throw new WebsiteScanError("website_redirect_invalid");
          let nextUrl: string;
          try { nextUrl = new URL(location, url).href; } catch { throw new WebsiteScanError("website_redirect_invalid"); }
          url = validateWebsiteUrl(nextUrl);
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new WebsiteScanError("website_http_error");
        const contentType = response.headers["content-type"] ?? "";
        if (!/^(?:text\/html|text\/plain)(?:\s*;|\s*$)/iu.test(contentType)) throw new WebsiteScanError("website_content_type_denied");
        if (response.headers["content-encoding"] && response.headers["content-encoding"].toLowerCase() !== "identity") throw new WebsiteScanError("website_encoding_denied");
        if (response.body.byteLength > limits.maxBytes) throw new WebsiteScanError("website_response_too_large");
        const extracted = extractWebsiteText(Buffer.from(response.body).toString("utf8"), /^text\/plain(?:\s*;|\s*$)/iu.test(contentType));
        if (!extracted.text) throw new WebsiteScanError("website_content_empty");
        if (extracted.text.length > limits.maxTextCharacters) throw new WebsiteScanError("website_text_too_large");
        // Versions persist extracted body text; source names are managed separately.
        const contentHash = createHash("sha256").update(extracted.text).digest("hex");
        return {
          requestedUrl: requested.href, finalUrl: url.href, ...extracted, contentHash,
          scannedAt: new Date().toISOString(), trust: "untrusted_external_content" as const,
          change: {
            kind: options.previousHash ? (options.previousHash === contentHash ? "unchanged" as const : "changed" as const) : "initial" as const,
            requiresApproval: true as const, previousHash: options.previousHash ?? null, proposedHash: contentHash,
          },
        };
      }
      throw new WebsiteScanError("website_redirect_limit");
    })(), timeout]);
  } catch (error) {
    // Never leak page content, credentials or arbitrary provider messages to callers/logs.
    if (error instanceof WebsiteScanError) throw error;
    throw new WebsiteScanError(controller.signal.aborted ? "website_scan_timeout" : "website_fetch_failed");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
