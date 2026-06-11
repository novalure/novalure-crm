#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(".env.local");
loadEnv(".env.production.local");

const baseUrl = (process.env.NOVALURE_QA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const loginEmail = process.env.NOVALURE_QA_EMAIL || process.env.QA_LOGIN_EMAIL || "franz@novalure.local";
const loginPassword =
  process.env.NOVALURE_QA_PASSWORD ||
  process.env.QA_LOGIN_PASSWORD ||
  process.env.NOVALURE_LOGIN_PASSCODE ||
  "";
const browserPort = Number(process.env.NOVALURE_QA_CDP_PORT || "9231");
const runStamp = Date.now();
const contactName = `QA Contact DB First UI ${runStamp}`;
const editedContactName = `${contactName} Edited`;
const contactEmail = `qa-ui-${runStamp}@example.test`;
const screenshotDir = process.env.NOVALURE_QA_SCREENSHOT_DIR || path.join("docs", "audit", "2026-06-09", "contact-ui-screenshots");

if (!loginPassword) {
  console.error(
    "Missing QA password. Set NOVALURE_QA_PASSWORD or QA_LOGIN_PASSWORD. Plain NOVALURE_LOGIN_PASSCODE is used only when available locally.",
  );
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

function findBrowserExecutable() {
  const candidates = [
    process.env.NOVALURE_QA_BROWSER,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function openPageTarget(port, url) {
  const encodedUrl = encodeURIComponent(url);
  const endpoints = [
    `http://127.0.0.1:${port}/json/new?${encodedUrl}`,
    `http://127.0.0.1:${port}/json/new?url=${encodedUrl}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { method: "PUT" });
      if (response.ok) return await response.json();
    } catch {
      // Try the next Chrome-compatible endpoint shape.
    }
  }

  const targets = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw new Error("No browser page target is available");
  return page;
}

function createCdpClient(webSocketUrl) {
  const url = new URL(webSocketUrl);
  const socket = net.createConnection(Number(url.port), url.hostname);
  const pending = new Map();
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let handshakeComplete = false;
  let settled = false;

  const sendFrame = (text) => {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    const maskedPayload = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      maskedPayload[index] = payload[index] ^ mask[index % 4];
    }
    socket.write(Buffer.concat([header, mask, maskedPayload]));
  };

  const processFrames = () => {
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < offset + 2) return;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return;
        payloadLength = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLength) return;

      let payload = buffer.subarray(offset, offset + payloadLength);
      buffer = buffer.subarray(offset + payloadLength);

      if (masked && mask) {
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode !== 0x1) continue;

      const message = JSON.parse(payload.toString("utf8"));
      if (!message.id || !pending.has(message.id)) continue;

      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result ?? {});
    }
  };

  return new Promise((resolve, reject) => {
    socket.once("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        [
          `GET ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          "",
          "",
        ].join("\r\n"),
      );
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeComplete) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headers = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        if (!headers.includes(" 101 ")) {
          reject(new Error(`CDP websocket handshake failed: ${headers.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }

        handshakeComplete = true;
        settled = true;
        resolve({
          close: () => socket.destroy(),
          send(method, params = {}) {
            const id = nextId++;
            sendFrame(JSON.stringify({ id, method, params }));
            return new Promise((commandResolve, commandReject) => {
              pending.set(id, { resolve: commandResolve, reject: commandReject });
            });
          },
        });
      }

      processFrames();
    });

    socket.once("error", (error) => {
      if (!settled) reject(error);
      for (const { reject: rejectCommand } of pending.values()) {
        rejectCommand(error);
      }
      pending.clear();
    });
    socket.once("close", () => {
      if (!settled) reject(new Error("CDP websocket closed before connection"));
      for (const { reject: rejectCommand } of pending.values()) {
        rejectCommand(new Error("CDP websocket closed"));
      }
      pending.clear();
    });
  });
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(detail);
  }

  return result.result?.value;
}

function pageScript(fn, args = {}) {
  return `(${fn.toString()})(${JSON.stringify(args)})`;
}

async function saveScreenshot(client, fileName) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const result = await client.send("Page.captureScreenshot", {
    captureBeyondViewport: true,
    format: "png",
    fromSurface: true,
  });
  const filePath = path.join(screenshotDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  console.log(`PASS screenshot saved: ${filePath}`);
}

async function waitFor(client, predicate, message, timeoutMs = 15000, args = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await evaluate(client, pageScript(predicate, args))) return;
    } catch {
      // The page can briefly have no body while Chrome swaps documents during navigation.
    }
    await sleep(250);
  }

  const excerpt = await evaluate(
    client,
    pageScript(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 900)),
  ).catch(() => "");
  throw new Error(`Timed out waiting for ${message}${excerpt ? `; page text: ${excerpt}` : ""}`);
}

async function openContactsView(client) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15000) {
    const addContactVisible = await evaluate(
      client,
      pageScript(() => {
        if (location.hash !== "#contacts") {
          location.hash = "contacts";
        }
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        const contactsButton = Array.from(document.querySelectorAll("button")).find((item) =>
          /^(contacts|kontakte)$/i.test(item.textContent?.trim() ?? ""),
        );
        contactsButton?.click();

        return Array.from(document.querySelectorAll("button")).some((item) =>
          /add contact|kontakt hinzufügen|kontakt anlegen/i.test(item.textContent?.trim() ?? ""),
        );
      }),
    );

    if (addContactVisible) return;
    await sleep(300);
  }

  const excerpt = await evaluate(
    client,
    pageScript(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 900)),
  ).catch(() => "");
  throw new Error(`Timed out waiting for contacts view${excerpt ? `; page text: ${excerpt}` : ""}`);
}

async function contactExistsInCore(client, name) {
  return await evaluate(
    client,
    pageScript(async ({ name: expectedName }) => {
      const response = await fetch("/api/crm/core", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`CRM core returned HTTP ${response.status}`);
      const payload = await response.json();
      return Boolean((payload.data?.contacts ?? []).some((contact) => contact.name === expectedName));
    }, { name }),
  );
}

async function archiveStaleQaUiContacts(client) {
  return await evaluate(
    client,
    pageScript(async ({ currentName }) => {
      const response = await fetch("/api/crm/core", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Could not load CRM core for QA cleanup");
      const core = await response.json();
      const staleContacts = (core.contacts ?? []).filter((contact) =>
        typeof contact.name === "string" &&
        contact.name.startsWith("QA Contact DB First UI ") &&
        contact.name !== currentName,
      );

      for (const contact of staleContacts) {
        await fetch(`/api/crm/contacts?id=${encodeURIComponent(contact.id)}`, {
          credentials: "same-origin",
          method: "DELETE",
        });
      }

      return staleContacts.length;
    }, { currentName: contactName }),
  );
}

async function main() {
  const browserExecutable = findBrowserExecutable();
  if (!browserExecutable) throw new Error("Chrome or Edge executable was not found");

  const profileDir = path.join(os.tmpdir(), `novalure-crm-ui-${runStamp}`);
  const browserProcess = spawn(
    browserExecutable,
    [
      "--headless=new",
      `--remote-debugging-port=${browserPort}`,
      `--user-data-dir=${profileDir}`,
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--remote-allow-origins=*",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let client;
  try {
    await waitForJson(`http://127.0.0.1:${browserPort}/json/version`);
    const target = await openPageTarget(browserPort, `${baseUrl}/login`);
    client = await createCdpClient(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 1000,
      mobile: false,
      width: 1440,
    });
    await client.send("Page.navigate", { url: `${baseUrl}/login` });
    await waitFor(
      client,
      () => document.readyState === "complete" || document.readyState === "interactive",
      "login page readiness",
    );
    await saveScreenshot(client, "01-login-page.png");

    await evaluate(
      client,
      pageScript(({ email, password }) => {
        const setInput = (input, value) => {
          const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const inputs = Array.from(document.querySelectorAll("input"));
        const emailInput = inputs.find((input) => input.type === "email") ?? inputs[0];
        const passwordInput = inputs.find((input) => input.type === "password") ?? inputs[1];
        if (!emailInput || !passwordInput) throw new Error("Login inputs are not visible");
        setInput(emailInput, email);
        setInput(passwordInput, password);
        const form = passwordInput.closest("form") ?? emailInput.closest("form");
        const loginButton = Array.from(document.querySelectorAll("button")).find((button) => {
          const label = button.textContent?.trim() ?? "";
          return /^(anmelden|einloggen|login|log in|sign in)$/i.test(label) || /anmelden|login|log in|sign in/i.test(label);
        });

        if (form instanceof HTMLFormElement && typeof form.requestSubmit === "function") {
          form.requestSubmit(loginButton instanceof HTMLButtonElement ? loginButton : undefined);
          return;
        }

        if (!loginButton) throw new Error("Login submit button is not visible");
        loginButton.click();
      }, { email: loginEmail, password: loginPassword }),
    );
    await waitFor(
      client,
      () => location.pathname === "/" && /sign out|abmelden|project-based leads|projektbasierte leads/i.test(document.body.innerText ?? ""),
      "CRM home",
    );
    assert(true, "UI login reaches the CRM workspace");
    await saveScreenshot(client, "02-after-login.png");
    const staleQaContacts = await archiveStaleQaUiContacts(client);
    if (staleQaContacts > 0) {
      console.log(`PASS archived stale UI QA contacts: ${staleQaContacts}`);
    }

    await client.send("Page.navigate", { url: `${baseUrl}/#contacts` });
    await openContactsView(client);
    await saveScreenshot(client, "03-contact-list.png");

    await evaluate(
      client,
      pageScript(() => {
        const button = Array.from(document.querySelectorAll("button")).find((item) =>
          /add contact|kontakt hinzufügen|kontakt anlegen/i.test(item.textContent?.trim() ?? ""),
        );
        if (!button) {
          const labels = Array.from(document.querySelectorAll("button"))
            .map((item) => item.textContent?.trim())
            .filter(Boolean)
            .slice(0, 40)
            .join(" | ");
          throw new Error(`Add contact button is not visible. Buttons: ${labels}`);
        }
        button.click();
      }),
    );
    await waitFor(
      client,
      () => /create contact manually|neuen kontakt manuell erstellen|kontakt manuell/i.test(document.body.innerText ?? ""),
      "create contact form",
    );
    await saveScreenshot(client, "04-contact-create-form.png");

    await evaluate(
      client,
      pageScript(({ name, email }) => {
        const createPanel = Array.from(document.querySelectorAll("article")).find((article) =>
          /create contact manually|neuen kontakt manuell erstellen/i.test(article.textContent ?? ""),
        );
        if (!createPanel) throw new Error("Create contact panel is not visible");
        const setLabeledInput = (labelText, value) => {
          const labelPattern =
            labelText === "Email" ? /^(email|e-mail)\b/i :
              labelText === "Phone" ? /^(phone|telefon)\b/i :
                labelText === "Need" ? /^(need|bedarf)\b/i :
                  new RegExp(`^${labelText}\\b`, "i");
          const label = Array.from(createPanel.querySelectorAll("label")).find((item) =>
            labelPattern.test(item.textContent?.trim() ?? ""),
          );
          const input = label?.querySelector("input, textarea");
          if (!input) throw new Error(`${labelText} field is not visible`);
          const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setLabeledInput("Name", name);
        setLabeledInput("Email", email);
        setLabeledInput("Phone", "+43 660 555 0101");
        setLabeledInput("Need", "QA UI persistence contact");
        const saveButton = Array.from(createPanel.querySelectorAll("button")).find((button) =>
          /save contact|kontakt speichern/i.test(button.textContent ?? ""),
        );
        if (!saveButton) throw new Error("Save contact button is not visible");
        saveButton.click();
      }, { name: contactName, email: contactEmail }),
    );
    await waitFor(client, () => /contact added\.|kontakt wurde hinzugefügt\./i.test(document.body.innerText ?? ""), "contact creation success");
    await waitFor(
      client,
      ({ name }) => document.body.innerText.includes(name),
      "created contact visibility",
      10000,
      { name: contactName },
    );
    assert(true, "UI contact create shows the server-returned contact");
    await saveScreenshot(client, "05-contact-created.png");

    await evaluate(
      client,
      pageScript(() => {
        const button = Array.from(document.querySelectorAll("button")).find((item) =>
          /refresh|aktualisieren/i.test(item.textContent?.trim() ?? ""),
        );
        if (!button) throw new Error("Refresh button is not visible");
        button.click();
      }),
    );
    await waitFor(
      client,
      ({ name }) => document.body.innerText.includes(name),
      "created contact after refresh",
      15000,
      { name: contactName },
    );
    assert(await contactExistsInCore(client, contactName), "created contact is returned by authenticated CRM core data");
    assert(true, "UI contact remains visible after refresh");

    await evaluate(
      client,
      pageScript(({ name }) => {
        const button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent?.includes(name),
        );
        button?.click();
      }, { name: contactName }),
    );

    await evaluate(
      client,
      pageScript(({ editedName }) => {
        const editPanel = Array.from(document.querySelectorAll("article")).find((article) =>
          /edit contact|kontakt bearbeiten/i.test(article.textContent ?? ""),
        );
        if (!editPanel) throw new Error("Edit contact panel is not visible");
        const nameLabel = Array.from(editPanel.querySelectorAll("label")).find((item) =>
          item.textContent?.trim().startsWith("Name"),
        );
        if (!nameLabel) throw new Error("Name field is not visible in edit panel");
        const input = nameLabel.querySelector("input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter.call(input, editedName);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { editedName: editedContactName }),
    );
    await sleep(500);
    await evaluate(
      client,
      pageScript(() => {
        const editPanel = Array.from(document.querySelectorAll("article")).find((article) =>
          /edit contact|kontakt bearbeiten/i.test(article.textContent ?? ""),
        );
        if (!editPanel) throw new Error("Edit contact panel is not visible");
        const saveButton = Array.from(editPanel.querySelectorAll("button")).find((button) =>
          /save changes|änderungen speichern|aenderungen speichern/i.test(button.textContent ?? ""),
        );
        if (!saveButton) throw new Error("Save changes button is not visible");
        saveButton.click();
      }),
    );
    await waitFor(
      client,
      ({ name }) => document.body.innerText.includes(name),
      "edited contact visibility",
      15000,
      { name: editedContactName },
    );
    await saveScreenshot(client, "06-contact-edited.png");
    assert(await contactExistsInCore(client, editedContactName), "edited contact is returned by authenticated CRM core data");
    assert(true, "UI contact edit persists in authenticated CRM core data");
    await openContactsView(client);

    await evaluate(
      client,
      pageScript(({ name }) => {
        const button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent?.includes(name),
        );
        button?.click();
      }, { name: editedContactName }),
    );
    await waitFor(
      client,
      ({ name }) => document.querySelector("article")?.innerText?.includes(name) || document.body.innerText.includes(name),
      "edited contact selection",
      10000,
      { name: editedContactName },
    );

    await evaluate(
      client,
      pageScript(() => {
        const editPanel = Array.from(document.querySelectorAll("article")).find((article) =>
          /edit contact|kontakt bearbeiten/i.test(article.textContent ?? ""),
        );
        if (!editPanel) throw new Error("Edit contact panel is not visible");
        const archiveButton = Array.from(editPanel.querySelectorAll("button")).find((button) =>
          /archive|archivieren/i.test(button.textContent?.trim() ?? ""),
        );
        if (!archiveButton) throw new Error("Archive button is not visible");
        archiveButton.click();
      }),
    );
    await waitFor(
      client,
      () => /confirm archive|archivieren bestätigen/i.test(document.body.innerText ?? ""),
      "archive confirmation",
    );
    await evaluate(
      client,
      pageScript(() => {
        const button = Array.from(document.querySelectorAll("button")).find((item) =>
          /confirm archive|archivieren bestätigen/i.test(item.textContent?.trim() ?? ""),
        );
        if (!button) throw new Error("Confirm archive button is not visible");
        button.click();
      }),
    );
    await waitFor(
      client,
      ({ name }) => !document.body.innerText.includes(name),
      "archived contact hidden",
      10000,
      { name: editedContactName },
    );
    assert(!(await contactExistsInCore(client, editedContactName)), "archived contact is absent from authenticated CRM core data");
    assert(true, "UI archive removes the contact from the normal list");
    await saveScreenshot(client, "07-contact-archived.png");

    console.log(`PASS UI QA contact cleaned up by archive: ${editedContactName}`);
  } finally {
    try {
      client?.close();
    } catch {
      // Ignore browser cleanup failures.
    }
    browserProcess.kill();
    await sleep(500);
    try {
      fs.rmSync(profileDir, { force: true, recursive: true });
    } catch {
      // Chrome can keep profile files locked briefly on Windows.
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
