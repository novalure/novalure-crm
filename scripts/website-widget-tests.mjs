import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const code = await readFile(new URL("../public/chat/widget.js", import.meta.url), "utf8");
// Synthetic public routing identifier; preserve base64url coverage without a secret-like literal.
const key = ["nov_pk", "AbCDefgh", "ijkl-mnopQRSTUVWXYZ123456"].join("_");
function browser({ language = "en", siteKey = key, src = "https://crm.example.invalid/chat/widget.js", pageUrl = "https://customer.example.invalid/", attributes = {}, responses = [] } = {}) {
  const nodes = [], requests = [];
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ""; this.hidden = false; this.style = { values: {}, setProperty(name, value) { this.values[name] = value; } }; nodes.push(this); }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || "") + this.children.map(child => child.textContent).join(""); }
    set innerHTML(_value) { throw new Error("Unsafe HTML rendering"); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...items) { for (const item of items) { if (item.parent) item.remove(); item.parent = this; this.children.push(item); } }
    attachShadow() { const root = new Node("shadow"); root.shadowRoot = root; this.shadow = root; return root; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    root() { return this.parent ? this.parent.root() : this; }
    focus() { this.root().activeElement = this; }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    get firstElementChild() { return this.children[0]; }
  }
  const body = new Node("body"), html = new Node("html"), script = new Node("script");
  script.src = src;
  script.setAttribute("data-site-key", siteKey);
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  html.lang = language;
  const location = new URL(pageUrl);
  const document = { body, documentElement: html, currentScript: script, createElement: tag => new Node(tag), querySelector: () => body.children.find(node => "data-novalure-chat-host" in node.attributes) ?? null };
  const context = vm.createContext({ document, location, navigator: { language }, URL, crypto: webcrypto, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const answer = await responses.shift();
      if (!answer) throw new Error("Unexpected network request");
      return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, json: async () => answer.body };
    },
  });
  vm.runInContext(code, context);
  return { nodes, requests, body, context, find: tag => nodes.find(node => node.tag === tag), byClass: name => nodes.find(node => node.className === name) };
}
const started = { body: { sessionId: "11111111-1111-4111-8111-111111111111", sessionToken: "opaque_session_token_12345678901234567890", status: "active", mode: "training", widget: { assistantName: "<img onerror=alert(1)>" } } };
const answered = { body: { contractVersion: "website-answer-v1", answerStatus: "grounded", answer: "<script>alert(1)</script> Approved answer", citations: [{ title: "<img src=x onerror=alert(1)>", sourceId: "source", versionId: "version" }] } };
const submit = async state => { state.find("textarea").value = "What does the website cost?"; await state.find("form").listeners.submit({ preventDefault() {} }); };
const embedPresentation = {
  "data-assistant-name": "SYNTHETIC Hanna",
  "data-brand-name": "SYNTHETIC company",
  "data-welcome-message": "SYNTHETIC welcome before the first question.",
  "data-assistant-subtitle": "SYNTHETIC AI website assistant",
  "data-assistant-avatar": "/chat/avatars/synthetic-hanna.webp",
  "data-privacy-url": "/v2/datenschutz/#ki-chat",
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
async function waitForRequests(state, count) {
  for (let turn = 0; turn < 30 && state.requests.length < count; turn += 1) await Promise.resolve();
  assert.equal(state.requests.length, count, "the expected request must start after the controlled response settles");
}

test("base64url key, lazy session, exact API origin and closure-only credentials", async () => {
  const state = browser({ responses: [started, answered, answered] });
  assert.equal(state.requests.length, 0);
  state.byClass("launcher").listeners.click();
  assert.equal(state.requests.length, 0, "opening alone creates no session");
  await submit(state);
  await submit(state);
  assert.equal(state.requests.length, 3);
  assert.match(state.requests[0].url, /^https:\/\/crm\.example\.invalid\/api\/public\/integrations\/chat\/sessions\?site_key=/);
  assert.match(state.requests[1].url, /\/answers\?site_key=/);
  for (const request of state.requests) {
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers["x-novalure-site-key"], key);
    assert.doesNotMatch(request.url, /opaque_session_token/);
  }
  assert.deepEqual(Object.keys(JSON.parse(state.requests[1].body)).sort(), ["message", "sessionId"]);
  assert.equal(state.requests[1].headers["x-novalure-session-token"], started.body.sessionToken);
  assert.ok(state.nodes.every(node => !JSON.stringify(node.attributes).includes(started.body.sessionToken)));
  assert.equal(state.context.session, undefined);
  assert.equal(state.find("textarea").maxLength, 2000);
});

test("model text, citation titles and assistant names remain text with focus and Escape support", async () => {
  const state = browser({ responses: [started, answered] });
  const launcher = state.byClass("launcher");
  launcher.listeners.click();
  await submit(state);
  assert.equal(state.nodes.filter(node => node.tag === "script").length, 1);
  assert.equal(state.nodes.filter(node => node.tag === "img").length, 0);
  assert.match(state.byClass("log").textContent, /<script>alert\(1\)<\/script>/);
  assert.match(state.byClass("title").textContent, /<img/);
  const shadow = state.find("shadow");
  assert.equal(shadow.activeElement, state.find("textarea"));
  state.byClass("panel").listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(state.byClass("panel").hidden, true);
  assert.equal(shadow.activeElement, launcher);
  assert.equal(launcher.getAttribute("aria-expanded"), "false");
});

test("German/Spanish failures are honest and expired credentials are discarded", async () => {
  for (const language of ["de", "es"]) {
    const state = browser({ language, responses: [started, { status: 403 }, started, { status: 429 }] });
    await submit(state);
    await submit(state);
    assert.equal(state.requests.filter(item => /\/sessions\?/.test(item.url)).length, 2);
    assert.match(state.byClass("log").textContent, language === "de" ? /nicht mehr verfügbar.*Zu viele Anfragen/s : /ya no está disponible.*Demasiadas solicitudes/s);
    assert.equal(state.byClass("send").disabled, false);
  }
});

test("invalid keys/URLs and duplicate embeds do not initialize another widget", () => {
  for (const options of [{ siteKey: "invalid" }, { src: "http://crm.example.invalid/chat/widget.js" }, { src: "https://user:secret@crm.example.invalid/chat/widget.js" }, { src: "https://crm.example.invalid/other.js" }]) assert.equal(browser(options).body.children.length, 0);
  const state = browser();
  vm.runInContext(code, state.context);
  assert.equal(state.body.children.length, 1);
  assert.equal(state.requests.length, 0);
});

test("strict-CSP layout uses the central external stylesheet and no inline style block", () => {
  const state = browser();
  const stylesheet = state.find("link"), host = state.body.children[0];
  assert.equal(stylesheet.rel, "stylesheet");
  assert.equal(stylesheet.href, "https://crm.example.invalid/chat/widget.css");
  assert.equal(state.nodes.some(node => node.tag === "style"), false);
  assert.equal(host.hidden, true);
  stylesheet.listeners.load();
  assert.equal(host.hidden, false);
  assert.equal(state.requests.length, 0, "styles and opening do not create a visitor session");
});

test("saved widget appearance and language replace generic defaults at the first session", async () => {
  const state = browser({ language: "en", responses: [{ body: { ...started.body, widget: {
    assistantName: "SYNTHETIC help", brandName: "SYNTHETIC company", welcomeMessage: "Willkommen beim Testunternehmen.",
    primaryColor: "#f5eedd", widgetPosition: "bottom_left", language: "de",
  } } }, answered] });
  assert.match(state.byClass("log").textContent, /Ask a question/);
  assert.equal(state.requests.length, 0);
  await submit(state);
  const host = state.body.children[0];
  assert.equal(host.getAttribute("data-position"), "bottom_left");
  assert.equal(host.getAttribute("lang"), "de");
  assert.equal(host.style.values["--novalure-primary-color"], "#f5eedd");
  assert.equal(host.style.values["--novalure-button-text"], "#182431");
  assert.equal(state.byClass("title").textContent, "SYNTHETIC help");
  assert.equal(state.byClass("brand").textContent, "SYNTHETIC company");
  assert.equal(state.byClass("brand").hidden, false);
  assert.equal(state.byClass("send").textContent, "Senden");
  assert.equal(state.byClass("label").textContent, "Deine Frage");
  assert.equal(state.byClass("mode").textContent, "Testmodus");
  assert.match(state.byClass("log").textContent, /Willkommen beim Testunternehmen/);
  assert.match(state.byClass("log").textContent, /KI-Antworten können Fehler enthalten/);
  assert.doesNotMatch(state.byClass("log").textContent, /Ask a question about our published information/);
});

test("untrusted appearance values cannot inject CSS, HTML or resource URLs", async () => {
  const state = browser({ responses: [{ body: { ...started.body, widget: {
    assistantName: "<img src=x onerror=alert(1)>", brandName: "<script>invalid()</script>", welcomeMessage: "<b>Text only</b>",
    primaryColor: "red;background:url(https://attacker.invalid)", widgetPosition: "bottom_left;display:none", language: "de;bad",
  } } }, answered] });
  await submit(state);
  const host = state.body.children[0];
  assert.deepEqual(host.style.values, {});
  assert.equal(host.getAttribute("data-position"), null);
  assert.equal(host.getAttribute("lang"), "en");
  assert.equal(state.nodes.filter(node => node.tag === "script").length, 1);
  assert.equal(state.nodes.filter(node => node.tag === "img" || node.tag === "style").length, 0);
  assert.match(state.byClass("brand").textContent, /<script>/);
  assert.match(state.byClass("log").textContent, /<b>Text only<\/b>/);
  assert.ok(state.requests.every(request => request.url.startsWith("https://crm.example.invalid/")));
});

test("optional presentation is visible on first open without creating a session", () => {
  const state = browser({ language: "de", attributes: embedPresentation });
  assert.equal(state.requests.length, 0);
  state.find("link").listeners.load();
  state.byClass("launcher").listeners.click();
  assert.equal(state.byClass("panel").hidden, false);
  assert.equal(state.byClass("title").textContent, embedPresentation["data-assistant-name"]);
  assert.equal(state.byClass("brand").textContent, embedPresentation["data-brand-name"]);
  assert.equal(state.byClass("subtitle").textContent, embedPresentation["data-assistant-subtitle"]);
  assert.ok(state.byClass("log").textContent.includes(embedPresentation["data-welcome-message"]));
  assert.match(state.byClass("log").textContent, /KI-Antworten können Fehler enthalten/);
  assert.equal(state.byClass("panel").getAttribute("aria-label"), embedPresentation["data-assistant-name"]);
  assert.equal(state.byClass("avatar").src, "https://crm.example.invalid/chat/avatars/synthetic-hanna.webp");
  assert.equal(state.byClass("avatar").referrerPolicy, "no-referrer");
  assert.equal(state.find("a").href, "https://customer.example.invalid/v2/datenschutz/#ki-chat");
  assert.equal(state.byClass("typing").hidden, true);
  assert.notEqual(state.find("form").getAttribute("aria-busy"), "true");
  assert.equal(state.byClass("send").getAttribute("aria-label"), "Senden");
  assert.equal(state.nodes.some(node => node.tag === "input" && node.type === "file"), false);
  assert.equal(state.requests.length, 0, "opening customized presentation does not create a session or call the answer API");
});

test("generic and empty embeds retain localized defaults and identify the assistant as AI", () => {
  for (const [language, disclosure] of [["en", /\bAI\b/], ["de", /\bKI\b/], ["es", /\bIA\b/]]) {
    const state = browser({ language, attributes: Object.fromEntries(Object.keys(embedPresentation).map(name => [name, "   "])) });
    assert.match(state.byClass("subtitle").textContent, disclosure);
    assert.ok(state.byClass("title").textContent.trim());
    assert.ok(state.byClass("log").textContent.trim());
    assert.equal(state.nodes.filter(node => node.tag === "img").length, 0);
    assert.ok(state.nodes.filter(node => node.tag === "a").every(node => !node.href && !node.getAttribute("href")));
    assert.equal(state.requests.length, 0);
  }
});

test("embed text is literal and bounded without introducing HTML or resource URLs", () => {
  const malicious = "<img src=x onerror=alert(1)><script>invalid()</script>";
  const state = browser({ attributes: {
    "data-assistant-name": malicious,
    "data-brand-name": malicious,
    "data-welcome-message": malicious,
    "data-assistant-subtitle": malicious,
    "data-assistant-avatar": "javascript:alert(1)",
    "data-privacy-url": "javascript:alert(1)",
  } });
  for (const name of ["title", "brand", "subtitle"]) assert.equal(state.byClass(name).textContent, malicious);
  assert.ok(state.byClass("log").textContent.includes(malicious));
  assert.equal(state.nodes.filter(node => node.tag === "script").length, 1);
  assert.equal(state.nodes.filter(node => node.tag === "img" || node.tag === "style").length, 0);
  assert.ok(state.nodes.every(node => !Object.keys(node.attributes).some(name => /^on/i.test(name))));
  assert.ok(state.nodes.filter(node => node.tag === "a").every(node => !node.href && !node.getAttribute("href")));
  const long = browser({ attributes: { "data-assistant-name": "n".repeat(200), "data-brand-name": "b".repeat(200), "data-welcome-message": "w".repeat(800) } });
  assert.equal(long.byClass("title").textContent, "n".repeat(120));
  assert.equal(long.byClass("brand").textContent, "b".repeat(120));
  assert.ok(long.byClass("log").textContent.includes("w".repeat(500)));
  assert.ok(!long.byClass("log").textContent.includes("w".repeat(501)));
  assert.equal(state.requests.length + long.requests.length, 0);
});

test("avatars accept only central static raster assets and privacy stays on the customer origin", () => {
  for (const candidate of [
    "javascript:alert(1)", "data:image/svg+xml,<svg onload=alert(1)>", "blob:https://crm.example.invalid/id",
    "http://crm.example.invalid/chat/avatars/portrait.png", "https://attacker.invalid/chat/avatars/portrait.webp",
    "https://user:secret@crm.example.invalid/chat/avatars/portrait.png", "/api/media/portrait.webp",
    "/chat/avatars/portrait.svg", "/chat/avatars/portrait.webp?token=invalid", "/chat/avatars/portrait.webp#invalid",
    "/chat/avatars/../portrait.webp", "/chat/avatars/%2e%2e/portrait.webp", "/chat/avatars/portrait%2fprivate.webp",
  ]) {
    const state = browser({ attributes: { "data-assistant-avatar": candidate } });
    assert.equal(state.nodes.filter(node => node.tag === "img").length, 0, `reject avatar ${candidate}`);
    assert.equal(state.requests.length, 0);
  }
  for (const extension of ["webp", "png", "jpg", "jpeg", "avif"]) {
    const path = `/chat/avatars/synthetic-portrait.${extension}`;
    const state = browser({ attributes: { "data-assistant-avatar": `https://crm.example.invalid${path}` } });
    assert.equal(state.byClass("avatar").src, `https://crm.example.invalid${path}`);
  }
  for (const candidate of [
    "javascript:alert(1)", "data:text/html,invalid", "https://attacker.invalid/privacy", "//attacker.invalid/privacy",
    "http://customer.example.invalid/privacy", "https://user:secret@customer.example.invalid/privacy",
    "https://crm.example.invalid/privacy",
  ]) {
    const state = browser({ attributes: { "data-privacy-url": candidate } });
    assert.ok(state.nodes.filter(node => node.tag === "a").every(node => !node.href && !node.getAttribute("href")), `reject privacy ${candidate}`);
    assert.equal(state.requests.length, 0);
  }
  const local = browser({ pageUrl: "http://customer.example.invalid/example", attributes: { "data-privacy-url": "/privacy#chat" } });
  assert.equal(local.find("a").href, "http://customer.example.invalid/privacy#chat");
});

test("saved server presentation overrides embed fallbacks without changing request contracts", async () => {
  const state = browser({ attributes: embedPresentation, responses: [{ body: { ...started.body, widget: {
    assistantName: "SYNTHETIC saved assistant", brandName: "SYNTHETIC saved company", welcomeMessage: "SYNTHETIC saved greeting",
    assistantAvatarReference: "/chat/avatars/synthetic-saved.png", language: "es",
  } } }, answered] });
  assert.equal(state.byClass("title").textContent, embedPresentation["data-assistant-name"]);
  await submit(state);
  assert.equal(state.byClass("title").textContent, "SYNTHETIC saved assistant");
  assert.equal(state.byClass("brand").textContent, "SYNTHETIC saved company");
  assert.equal(state.byClass("subtitle").textContent, embedPresentation["data-assistant-subtitle"]);
  assert.match(state.byClass("log").textContent, /SYNTHETIC saved greeting/);
  assert.ok(!state.byClass("log").textContent.includes(embedPresentation["data-welcome-message"]));
  assert.match(state.byClass("log").textContent, /Las respuestas de IA pueden contener errores/);
  assert.equal(state.byClass("avatar").src, "https://crm.example.invalid/chat/avatars/synthetic-saved.png");
  assert.equal(state.byClass("send").textContent, "Enviar");
  assert.equal(state.byClass("send").getAttribute("aria-label"), "Enviar");
  assert.equal(state.byClass("mode").textContent, "Modo de prueba");
  assert.equal(state.find("a").href, "https://customer.example.invalid/v2/datenschutz/#ki-chat");
  assert.deepEqual(JSON.parse(state.requests[0].body), { language: "en" });
  assert.deepEqual(JSON.parse(state.requests[1].body), { sessionId: started.body.sessionId, message: "What does the website cost?" });
  for (const request of state.requests) {
    assert.ok(request.url.startsWith("https://crm.example.invalid/api/public/integrations/chat/"));
    for (const value of Object.values(embedPresentation)) assert.ok(!request.body.includes(value));
  }
});

test("invalid or absent server cosmetic fields retain safe embed fallbacks", async () => {
  const state = browser({ attributes: embedPresentation, responses: [{ body: { ...started.body, widget: {
    assistantName: "   ", brandName: 42, welcomeMessage: null,
    assistantAvatarReference: "https://attacker.invalid/chat/avatars/portrait.png",
  } } }, answered] });
  await submit(state);
  assert.equal(state.byClass("title").textContent, embedPresentation["data-assistant-name"]);
  assert.equal(state.byClass("brand").textContent, embedPresentation["data-brand-name"]);
  assert.ok(state.byClass("log").textContent.includes(embedPresentation["data-welcome-message"]));
  assert.equal(state.byClass("avatar").src, "https://crm.example.invalid/chat/avatars/synthetic-hanna.webp");
  assert.equal(state.nodes.filter(node => node.tag === "img").length, 1);
});

test("typing status follows real pending requests, blocks duplicate sends, and recovers after failure", async t => {
  const sessionReply = deferred(), answerReply = deferred(), failedReply = deferred();
  t.after(() => { sessionReply.resolve(started); answerReply.resolve(answered); failedReply.resolve({ status: 503 }); });
  const state = browser({ responses: [sessionReply.promise, answerReply.promise, failedReply.promise, answered] });
  const input = state.find("textarea"), form = state.find("form"), send = state.byClass("send"), typing = state.byClass("typing");
  state.byClass("launcher").listeners.click();
  assert.equal(typing.hidden, true);
  assert.equal(typing.getAttribute("role"), "status");
  assert.equal(typing.getAttribute("aria-live"), "polite");
  assert.equal(state.requests.length, 0);
  input.value = "First synthetic question";
  const firstSubmission = form.listeners.submit({ preventDefault() {} });
  assert.equal(state.requests.length, 1);
  assert.equal(typing.hidden, false);
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(send.disabled, true);
  assert.notEqual(input.disabled, true, "visitors can prepare their next question while awaiting an answer");
  input.value = "Prepared next question";
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(state.requests.length, 1, "a second submit cannot create another session or answer request");
  assert.equal(input.value, "Prepared next question");
  assert.equal(state.nodes.filter(node => node.className === "message user").length, 1);
  sessionReply.resolve({ body: { ...started.body, widget: { language: "de" } } });
  await waitForRequests(state, 2);
  assert.equal(typing.hidden, false, "typing remains visible between session creation and the answer");
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(send.disabled, true);
  answerReply.resolve(answered);
  await firstSubmission;
  assert.equal(typing.hidden, true);
  assert.notEqual(form.getAttribute("aria-busy"), "true");
  assert.equal(send.disabled, false);
  assert.equal(input.value, "Prepared next question");
  assert.equal(state.find("shadow").activeElement, input);
  const failedSubmission = form.listeners.submit({ preventDefault() {} });
  assert.equal(state.requests.length, 3);
  assert.equal(typing.hidden, false);
  assert.equal(send.disabled, true);
  failedReply.reject(new Error("Synthetic answer transport failure"));
  await failedSubmission;
  assert.equal(typing.hidden, true);
  assert.notEqual(form.getAttribute("aria-busy"), "true");
  assert.equal(send.disabled, false);
  assert.match(state.byClass("log").textContent, /gerade nicht erreichbar/);
  assert.equal(state.find("shadow").activeElement, input);
  await submit(state);
  assert.equal(state.requests.length, 4);
  assert.equal(state.requests.filter(request => /\/sessions\?/.test(request.url)).length, 1);
  assert.equal(typing.hidden, true);
  assert.equal(send.disabled, false);
});

test("the optional privacy link participates in the dialog focus loop", () => {
  const state = browser({ attributes: { "data-privacy-url": "/v2/datenschutz/#ki-chat" } });
  const panel = state.byClass("panel"), close = state.byClass("close"), privacy = state.find("a"), shadow = state.find("shadow");
  state.byClass("launcher").listeners.click();
  assert.ok(privacy && !privacy.hidden);
  close.focus();
  let prevented = false;
  panel.listeners.keydown({ key: "Tab", shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(shadow.activeElement, privacy, "reverse Tab from close reaches the final privacy link");
  prevented = false;
  panel.listeners.keydown({ key: "Tab", shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(shadow.activeElement, close);
  panel.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(panel.hidden, true);
  assert.equal(shadow.activeElement, state.byClass("launcher"));
});
