import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";

const root = fileURLToPath(new URL("../out/", import.meta.url));
const port = Number(process.env.DESIGN_C_PORT ?? 3190);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

try {
  await stat(resolve(root, "index.html"));
} catch {
  throw new Error(
    "Design-C-Export fehlt. Zuerst npm run design:c:build ausführen.",
  );
}

createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  try {
    const urlPath = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    let path = resolve(root, `.${urlPath}`);
    if (path !== resolve(root) && !path.startsWith(`${resolve(root)}${sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
    const bytes = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Nicht gefunden");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(
    `Design C: http://127.0.0.1:${port} · nur lokale synthetische Vorschau`,
  ),
);
