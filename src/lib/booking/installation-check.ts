import "server-only";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { isPublicIpAddress, validateWebsiteUrl } from "@/lib/knowledge-center/website-scanner";
import { BookingError } from "./types";

type InstallationInput = { url: string; publicId: string; embedOrigin: string; allowedOrigins: readonly string[] };
type InstallationResult = { originAllowed: boolean; reachable: boolean; markerFound: boolean; scriptFound: boolean; executed: false };
const maxBytes = 512_000;
function normalizeIp(address: string) {
  const clean = address.replace(/^::ffff:/i, "");
  return isIP(clean) === 6 ? new URL(`https://[${clean}]`).hostname.toLowerCase() : clean;
}

async function readPublicHtml(url: URL): Promise<string> {
  const signal = AbortSignal.timeout(8_000);
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new BookingError("INSTALLATION_CHECK_UNAVAILABLE", 503)), { once: true }));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), aborted]);
  if (!addresses.length || addresses.length > 32 || addresses.some(address => !isPublicIpAddress(address.address))) throw new BookingError("INSTALLATION_CHECK_ADDRESS_DENIED");
  signal.throwIfAborted();
  const selected = addresses[0];
  return new Promise<string>((resolve, reject) => {
    const failed = () => reject(new BookingError("INSTALLATION_CHECK_UNAVAILABLE", 503));
    const outgoing = request(url, { method: "GET", signal, agent: false, family: selected.family, maxHeaderSize: 16_384,
      servername: isIP(hostname) ? "" : hostname,
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      headers: { accept: "text/html", "accept-encoding": "identity", "user-agent": "Novalure-Booking-Install-Check/1.0" },
    }, response => {
      if (!response.socket.remoteAddress || normalizeIp(response.socket.remoteAddress) !== normalizeIp(selected.address) || (response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300 ||
        !/^text\/html(?:\s*;|\s*$)/i.test(String(response.headers["content-type"] ?? "")) || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity" ||
        response.headers["content-length"] && (!/^\d+$/.test(String(response.headers["content-length"])) || Number(response.headers["content-length"]) > maxBytes)) {
        response.destroy(); outgoing.destroy(); failed(); return;
      }
      const chunks: Buffer[] = []; let total = 0;
      response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > maxBytes) { response.destroy(); outgoing.destroy(); failed(); } else chunks.push(chunk); });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", failed);
      response.on("aborted", failed);
    });
    outgoing.on("error", failed); outgoing.end();
  });
}

export async function checkBookingInstallation(input: InstallationInput, fetchHtml: (url: URL) => Promise<string> = readPublicHtml): Promise<InstallationResult> {
  let url: URL;
  try { url = validateWebsiteUrl(input.url); } catch { throw new BookingError("INSTALLATION_CHECK_URL_DENIED"); }
  if (!input.allowedOrigins.includes(url.origin)) throw new BookingError("INSTALLATION_CHECK_ORIGIN_FORBIDDEN", 403);
  const source = await fetchHtml(url);
  if (Buffer.byteLength(source) > maxBytes) throw new BookingError("INSTALLATION_CHECK_UNAVAILABLE", 503);
  const escaped = input.publicId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerFound = new RegExp(`\\bdata-novalure-booking\\s*=\\s*["']${escaped}["']`, "i").test(source);
  const scriptFound = [...source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].some(match => {
    try { const script = new URL(match[1].replaceAll("&amp;", "&"), url); return script.origin === input.embedOrigin && script.pathname === "/appointments/embed.js"; } catch { return false; }
  });
  return { originAllowed: true, reachable: true, markerFound, scriptFound, executed: false };
}
