import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const code = await readFile(new URL("../public/chat/widget.js", import.meta.url), "utf8");
// Synthetic public routing identifier; preserve base64url coverage without a secret-like literal.
const key = ["nov_pk", "AbCDefgh", "ijkl-mnopQRSTUVWXYZ123456"].join("_");
function browser({ language = "en", siteKey = key, src = "https://crm.example.invalid/chat/widget.js", responses = [] } = {}) {
  const nodes = [], requests = [];
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ""; this.hidden = false; this.style = { values: {}, setProperty(name, value) { this.values[name] = value; } }; nodes.push(this); }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || "") + this.children.map(child => child.textContent).join(""); }
    set innerHTML(_value) { throw new Error("Unsafe HTML rendering"); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    attachShadow() { const root = new Node("shadow"); root.shadowRoot = root; this.shadow = root; return root; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    root() { return this.parent ? this.parent.root() : this; }
    focus() { this.root().activeElement = this; }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    get firstElementChild() { return this.children[0]; }
  }
  const body = new Node("body"), html = new Node("html"), script = new Node("script");
  script.src = src;
  script.setAttribute("data-site-key", siteKey);
  html.lang = language;
  const document = { body, documentElement: html, currentScript: script, createElement: tag => new Node(tag), querySelector: () => body.children.find(node => "data-novalure-chat-host" in node.attributes) ?? null };
  const context = vm.createContext({ document, navigator: { language }, URL, crypto: webcrypto, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const answer = responses.shift();
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
