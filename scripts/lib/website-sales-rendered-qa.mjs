import assert from "node:assert/strict";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const digest = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
/** Independent host-side issuer. No builder-supplied PASS booleans are accepted.
 * The signing key is supplied only to this process, never the application/HTML.
 */
export async function inspectAndSignWebsiteDemo(options) {
  const { context, baseUrl, scope, artifactRecord, workflowId, qaActorId, issuer, keyId, sourceRevision, privateKeyPem, outputDirectory } = options;
  assert(artifactRecord?.artifact?.kind === "DEMO");
  assert.notEqual(artifactRecord.createdBy, qaActorId, "Builder cannot act as its independent QA actor");
  assert(/^[0-9a-f]{40}$/.test(sourceRevision));
  const base = new URL(baseUrl);
  assert(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname));
  const query = new URLSearchParams({ projectId: scope.projectId, companyId: scope.companyId, locationId: scope.locationId });
  // A human history projection deliberately omits raster bodies. Obtain the
  // full immutable artifact through this independently authenticated QA actor
  // and verify its complete digest before using any metadata for a certificate.
  const sourcePage = await context.newPage();
  let artifact;
  try {
    const source = await sourcePage.goto(new URL(`/api/crm/website-sales/studio/qa-render/${artifactRecord.id}/artifact?${query}`, base).href, { waitUntil: "domcontentloaded" });
    assert.equal(source?.status(), 200, "Independent QA must obtain the current full scoped artifact");
    artifact = await bounded(source.json(), "Full immutable QA artifact");
  } finally { await sourcePage.close(); }
  assert.equal(artifact.kind, "DEMO");
  const { artifactDigest, ...unsigned } = artifact;
  assert.equal(digest(canonical(unsigned)), artifactDigest, "Full immutable artifact digest must be recomputable");
  assert.equal(artifactDigest, artifactRecord.artifact.artifactDigest, "History selection and protected QA source must agree");
  assert.equal(artifact.identity.workspaceId, scope.workspaceId);
  for (const name of ["projectId", "companyId", "locationId"]) assert.equal(artifact.identity[name], scope[name]);
  assert.equal(digest(Buffer.from(artifact.content.html, "utf8")), artifact.content.htmlDigest);
  const assets = artifact.content.assets.map(asset => ({ path: asset.path, mediaType: asset.mediaType, sha256: asset.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(digest(canonical(assets)), artifact.content.assetManifestDigest);
  const renderUrl = new URL(`/api/crm/website-sales/studio/qa-render/${artifactRecord.id}/render?${query}`, base);
  const directory = path.resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  let analysisContext;
  const errors = [], forbidden = [], requests = [], scans = [], layouts = [];
  const assetResponses = new Map();
  const expectedAssets = new Map(artifact.content.assets.map(asset => [new URL(`./assets/${encodeURIComponent(asset.path)}`, renderUrl).href, asset]));
  page.on("response", response => {
    const asset = expectedAssets.get(response.url());
    if (!asset) return;
    // Inspect the bytes loaded by the authenticated browser itself. A separate
    // APIRequestContext has different browser-origin metadata and can be denied.
    const evidence = response.body().then(body => ({ status: response.status(), digest: digest(body), body }))
      .catch(() => ({ status: response.status(), digest: null }));
    assetResponses.set(asset.path, evidence);
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => {
    const url = new URL(request.url()); requests.push({ method: request.method(), path: url.pathname });
    if (url.origin !== base.origin || !["GET", "HEAD"].includes(request.method()) ||
      !url.pathname.startsWith(`/api/crm/website-sales/studio/qa-render/${artifactRecord.id}/`) && url.pathname !== "/favicon.ico") forbidden.push({ method: request.method(), path: url.pathname });
  });
  try {
    const loaded = await page.goto(renderUrl.href, { waitUntil: "networkidle" });
    assert.equal(loaded?.status(), 200, "QA must inspect the actual server-bound artifact");
    const htmlBytes = await loaded.body();
    assert.equal(digest(htmlBytes), artifact.content.htmlDigest, "Served HTML must be byte-identical to the artifact");
    const responseHeaders = await loaded.allHeaders();
    assert(responseHeaders["content-security-policy"]?.includes("script-src 'none'"));
    assert(responseHeaders["x-robots-tag"]?.includes("noindex"));
    const cachedAssets = new Map();
    for (const asset of artifact.content.assets) {
      assert(/^[a-zA-Z0-9_.-]+$/.test(asset.path), "Asset path is a single safe component");
      const response = await assetResponses.get(asset.path);
      assert(response, "QA browser must actually load every manifest asset");
      assert.equal(response.status, 200, "Browser-loaded asset must be authorized");
      assert.equal(response.digest, asset.sha256, "Every browser-loaded asset must match the manifest");
      cachedAssets.set(new URL(`./assets/${encodeURIComponent(asset.path)}`, renderUrl).href, { asset, body: response.body });
    }
    const unsafe = await bounded(page.evaluate(() => ({
      elements: document.querySelectorAll("script,iframe,object,embed,form,input,textarea,select,meta[http-equiv='refresh']").length,
      handlers: [...document.querySelectorAll("*")].some(element => [...element.attributes].some(attribute => /^on/i.test(attribute.name))),
      links: [...document.querySelectorAll("a[href]")].every(link => link.getAttribute("href")?.startsWith("#")),
    })), "Source DOM safety inspection");
    assert.equal(unsafe.elements, 0); assert.equal(unsafe.handlers, false); assert.equal(unsafe.links, true);
    // The original document keeps its strict HTTP sandbox. Its disabled script
    // callbacks also disable async axe. Audit the exact already-verified bytes in
    // a separate context with no cookies and no live network, then compare layout.
    const browser = context.browser(); assert(browser, "Independent analysis requires an isolated browser context");
    analysisContext = await browser.newContext({ bypassCSP: true, serviceWorkers: "block", acceptDownloads: false });
    const analysisRequests = [];
    await analysisContext.route("**/*", async route => {
      const request = route.request(), url = request.url();
      if (request.method() === "GET" && url === renderUrl.href) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: htmlBytes });
      const cached = cachedAssets.get(url);
      if (request.method() === "GET" && cached) return route.fulfill({ status: 200, contentType: cached.asset.mediaType, body: cached.body });
      if (request.method() === "GET" && url === new URL("/favicon.ico", base).href) return route.fulfill({ status: 404, body: "" });
      analysisRequests.push({ method: request.method(), path: new URL(url).pathname });
      return route.abort("blockedbyclient");
    });
    const analysisPage = await analysisContext.newPage(); analysisPage.setDefaultTimeout(10000);
    const analysisErrors = [];
    analysisPage.on("pageerror", error => analysisErrors.push(error.message));
    analysisPage.on("console", message => { if (message.type() === "error") analysisErrors.push(message.text()); });
    await analysisPage.goto(renderUrl.href, { waitUntil: "networkidle", timeout: 15000 });
    const axeSource = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
    await analysisPage.addScriptTag({ content: axeSource });
    for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["tablet", { width: 834, height: 1112 }], ["mobile", { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      await analysisPage.setViewportSize(viewport);
      const measurements = await bounded(page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        fontsLoaded: document.fonts.status === "loaded",
        images: [...document.images].every(image => image.complete && image.naturalWidth > 0),
        dangerous: document.querySelectorAll("script,iframe,object,embed,form,input,textarea,select,[onclick],[onerror],[onload]").length,
        links: [...document.querySelectorAll("a[href]")].map(link => ({ href: link.getAttribute("href"), height: link.getBoundingClientRect().height })),
      })), "Protected document layout inspection");
      assert(measurements.scrollWidth <= measurements.width + 1, `${name} layout must fit`);
      assert(measurements.images, "Images must actually load");
      assert(measurements.fontsLoaded, "The actual protected page must have loaded its fonts");
      assert.equal(measurements.dangerous, 0, "Demo cannot contain effectful controls or executable content");
      assert(measurements.links.every(link => link.href?.startsWith("#")), "Demo navigation stays in the simulated document");
      const mirrored = await bounded(analysisPage.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        heading: document.querySelector("h1")?.getBoundingClientRect().toJSON() })), "Offline layout comparison");
      const actualHeading = await bounded(page.evaluate(() => document.querySelector("h1")?.getBoundingClientRect().toJSON()), "Protected heading measurement");
      assert.equal(mirrored.width, measurements.width); assert.equal(mirrored.scrollWidth, measurements.scrollWidth);
      for (const dimension of ["x", "y", "width", "height"]) assert(Math.abs(mirrored.heading[dimension] - actualHeading[dimension]) <= 1, "Exact-byte offline analysis must retain the actual rendered layout");
      const scan = await bounded(analysisPage.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        return { violations: result.violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })), incomplete: result.incomplete.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })) };
      }), "Offline accessibility analysis");
      scans.push({ name, ...scan }); assert.deepEqual(scan.violations, [], `${name} accessibility violations require repair`);
      await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
      layouts.push({ name, ...measurements });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches));
    assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length), 0);
    await page.screenshot({ path: path.join(directory, "reduced-motion.png"), fullPage: true });
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, href: document.activeElement?.getAttribute("href"),
      outline: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : "none" }));
    assert.equal(focused.tag, "A"); assert(focused.href?.startsWith("#")); assert.notEqual(focused.outline, "none");
    await page.keyboard.press("Enter");
    async function focusNative(predicate, label) {
      for (let step = 0; step < 20; step++) {
        await page.keyboard.press("Tab");
        const active = await bounded(page.evaluate(() => ({ tag: document.activeElement?.tagName, href: document.activeElement?.getAttribute("href"), text: document.activeElement?.textContent?.trim() })), "Native keyboard focus inspection");
        if (predicate(active)) return;
      }
      throw Error(`Keyboard could not reach ${label}`);
    }
    await focusNative(active => active.href === "#proposal", "Proposal");
    await page.keyboard.press("Enter"); await page.waitForURL(url => url.hash === "#proposal", { timeout: 3000 });
    assert.equal(new URL(page.url()).hash, "#proposal");
    await focusNative(active => active.href === "#scope", "Scope");
    await page.keyboard.press("Enter"); await page.waitForURL(url => url.hash === "#scope", { timeout: 3000 });
    assert.equal(new URL(page.url()).hash, "#scope");
    await focusNative(active => active.tag === "SUMMARY" && active.text === "Exclusions and assumptions", "scope details");
    await page.keyboard.press("Space");
    assert.equal(await bounded(page.evaluate(() => document.querySelector("details")?.getAttribute("open")), "Native details state"), "");
    assert.deepEqual(analysisRequests, [], "Offline accessibility analysis cannot access the live network");
    assert.deepEqual(analysisErrors, [], "Accessibility analysis must complete without script errors");
    assert.deepEqual(errors, [], "Browser errors cannot be signed away"); assert.deepEqual(forbidden, []);
    const now = Date.now(), expiry = Math.min(now + 3600000, Date.parse(artifact.validUntil));
    assert(expiry > now + 1000);
    const payload = { contractVersion: "website-sales-rendered-qa-v1", issuer, keyId, certificateId: randomUUID(),
      ...scope, workflowId, artifactDigest: artifact.artifactDigest, htmlDigest: artifact.content.htmlDigest, assetManifestDigest: artifact.content.assetManifestDigest,
      evidenceDigest: artifact.evidenceDigest, qaActorId, sourceRevision, checkedAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString(),
      checks: { desktop: true, tablet: true, mobile: true, reducedMotion: true, keyboard: true, noConsoleErrors: true, noSideEffects: true } };
    const privateKey = createPrivateKey(privateKeyPem); assert.equal(privateKey.asymmetricKeyType, "ed25519");
    const certificate = { payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64url") };
    await writeFile(path.join(directory, "rendered-qa.json"), JSON.stringify({ artifactId: artifactRecord.id, artifactDigest: artifact.artifactDigest, actualHtmlDigest: artifact.content.htmlDigest, layouts, scans, accessibilityAnalysis: "BYTE_IDENTICAL_OFFLINE_DOM_NO_AUTHENTICATION_NO_LIVE_NETWORK", analysisRequests, focused, errors, forbidden, requests, certificate }, null, 2));
    return certificate;
  } finally { await analysisContext?.close(); await page.close(); }
}
