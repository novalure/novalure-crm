#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { neon } from "@neondatabase/serverless";

const productionEnvPath = fs.existsSync(".env.vercel-production.local")
  ? ".env.vercel-production.local"
  : ".env.production.local";
const liveOnboardingEnvPath = ".env.codex.live-onboarding.local";
const screenshotDir = path.join("docs", "audit", "2026-06-11", "live-onboarding-implementation");
const appUrl = "https://www.novalure-crm.app";
const localPort = Number(process.env.NOVALURE_ONBOARDING_LOCAL_PORT || "3028");
const cdpPort = Number(process.env.NOVALURE_ONBOARDING_CDP_PORT || "9238");
const databaseKeys = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_DATABASE_URL", "POSTGRES_PRISMA_URL"];
const users = {
  owner: "codextest-onboarding-owner@novalure.local",
  agent: "codextest-onboarding-agent@novalure.local",
  viewer: "codextest-onboarding-viewer@novalure.local",
};

function parseEnvFile(filePath, required = false) {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Env file not found: ${filePath}`);
    return new Map();
  }
  const values = new Map();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""));
  }
  return values;
}

function cleanDatabaseUrl(value) {
  if (!value) return "";
  const trimmed = String(value).trim().replace(/^['"]|['"]$/g, "");
  const match = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);
  return match?.[1] ?? trimmed;
}

function getDatabaseUrl(values) {
  for (const key of databaseKeys) {
    const value = cleanDatabaseUrl(values.get(key));
    if (value) return { key, value };
  }
  throw new Error("No production database URL found.");
}

function fingerprint(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return { database: parsed.pathname.slice(1), host: parsed.hostname, user: parsed.username };
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function assertLiveTarget(env, databaseUrl) {
  if ((env.get("VERCEL_ENV") ?? "") !== "production") {
    throw new Error("Blocked: production env is required.");
  }
  const target = fingerprint(databaseUrl);
  const text = `${target.host} ${target.database}`.toLowerCase();
  for (const indicator of ["tenant-isolation-test", "preview", "test"]) {
    if (text.includes(indicator)) throw new Error(`Blocked non-live database indicator: ${indicator}`);
  }
}

function buildServerEnv(productionEnv) {
  const childEnv = {
    ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    Path: process.env.Path ?? process.env.PATH ?? "",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    USERPROFILE: process.env.USERPROFILE ?? "",
    windir: process.env.windir ?? process.env.SystemRoot ?? "C:\\Windows",
  };
  for (const [key, value] of productionEnv.entries()) {
    childEnv[key] = value;
  }
  childEnv.NODE_ENV = "production";
  childEnv.VERCEL_ENV = "development";
  childEnv.NOVALURE_AUTH_STRICT = "1";
  return childEnv;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextCdpPort = cdpPort;

function allocateCdpPort() {
  const port = nextCdpPort;
  nextCdpPort += 1;
  return port;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function login(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    body: new URLSearchParams({ email, password, returnTo: "/?lang=de#leadInbox" }),
    method: "POST",
    redirect: "manual",
  });
  const cookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  return { cookie, location: response.headers.get("location"), status: response.status };
}

async function requestJson(baseUrl, pathName, cookie, init = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // Some forbidden routes may return an empty body.
  }
  return { json, status: response.status };
}

function findBrowserExecutable() {
  return [
    process.env.NOVALURE_QA_BROWSER,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
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

async function openPageTarget(url, port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (response.ok) return response.json();
  const targets = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw new Error("No page target available");
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
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const maskedPayload = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      maskedPayload[index] = payload[index] ^ mask[index % 4];
    }
    socket.write(Buffer.concat([header, mask, maskedPayload]));
  };

  const processFrames = () => {
    while (buffer.length >= 2) {
      const secondByte = buffer[1];
      const opcode = buffer[0] & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (buffer.length < offset + 2) return;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        if (high !== 0) throw new Error("CDP frame is too large");
        payloadLength = low;
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
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      if (opcode === 0x8) return socket.end();
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
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeComplete) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headers = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        if (!headers.includes(" 101 ")) {
          reject(new Error(`CDP handshake failed: ${headers.split("\r\n")[0]}`));
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
      for (const { reject: rejectCommand } of pending.values()) rejectCommand(error);
      pending.clear();
    });
  });
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

function pageScript(fn, args = {}) {
  return `(${fn.toString()})(${JSON.stringify(args)})`;
}

async function waitFor(client, predicate, message, timeoutMs = 45000, args = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await evaluate(client, pageScript(predicate, args))) return;
    } catch {
      // Ignore transient document swaps.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function saveScreenshot(client, fileName) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const result = await client.send("Page.captureScreenshot", { captureBeyondViewport: false, format: "png", fromSurface: true });
  const filePath = path.join(screenshotDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  return filePath;
}

async function setViewport(client, width, height, mobile = false) {
  await client.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: mobile ? 2 : 1, height, mobile, width });
}

function parseCookiePair(cookieHeader) {
  const firstPart = cookieHeader?.split(";")[0] ?? "";
  const separator = firstPart.indexOf("=");
  if (separator === -1) throw new Error("Session cookie missing");
  return {
    name: firstPart.slice(0, separator),
    value: firstPart.slice(separator + 1),
  };
}

async function captureRole(baseUrl, email, password, fileName, mobile = false) {
  const executable = findBrowserExecutable();
  if (!executable) throw new Error("Chrome or Edge executable not found");
  const browserPort = allocateCdpPort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "novalure-live-onboarding-"));
  const browserProcess = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${browserPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,720",
    "about:blank",
  ], { stdio: "ignore" });
  let client;
  try {
    await waitForJson(`http://127.0.0.1:${browserPort}/json/version`, 15000);
    const target = await openPageTarget(`${baseUrl}/login?lang=de`, browserPort);
    client = await createCdpClient(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Runtime.enable");
    await setViewport(client, mobile ? 390 : 1280, mobile ? 844 : 720, mobile);
    const loginResult = await login(baseUrl, email, password);
    if (loginResult.status !== 303 || !loginResult.cookie) {
      throw new Error(`Browser login cookie setup failed for ${email}: ${loginResult.status}`);
    }
    const cookie = parseCookiePair(loginResult.cookie);
    await client.send("Network.setCookie", {
      httpOnly: true,
      name: cookie.name,
      path: "/",
      sameSite: "Lax",
      secure: false,
      url: baseUrl,
      value: cookie.value,
    });
    await client.send("Page.navigate", { url: `${baseUrl}/?lang=de#leadInbox` });
    await waitFor(client, () => /Setup-Checkliste|Setup checklist|Willkommen im Novalure CRM/.test(document.body?.innerText ?? ""), "onboarding checklist");
    await sleep(500);
    return await saveScreenshot(client, fileName);
  } finally {
    try {
      client?.close?.();
    } catch {
      // Ignore.
    }
    browserProcess.kill();
    await sleep(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Windows can keep the headless profile locked briefly after process shutdown.
    }
  }
}

async function captureLoginError(baseUrl) {
  const executable = findBrowserExecutable();
  if (!executable) throw new Error("Chrome or Edge executable not found");
  const browserPort = allocateCdpPort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "novalure-live-onboarding-"));
  const browserProcess = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${browserPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,720",
    "about:blank",
  ], { stdio: "ignore" });
  let client;
  try {
    await waitForJson(`http://127.0.0.1:${browserPort}/json/version`, 15000);
    const target = await openPageTarget(`${baseUrl}/login?lang=de&error=invalid_credentials`, browserPort);
    client = await createCdpClient(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await setViewport(client, 1280, 720, false);
    await waitFor(client, () => /E-Mail oder Zugangscode stimmen nicht/.test(document.body?.innerText ?? ""), "login error");
    return await saveScreenshot(client, "01-login-error-de.png");
  } finally {
    try {
      client?.close?.();
    } catch {
      // Ignore.
    }
    browserProcess.kill();
    await sleep(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Windows can keep the headless profile locked briefly after process shutdown.
    }
  }
}

async function captureLoginPage(baseUrl) {
  const executable = findBrowserExecutable();
  if (!executable) throw new Error("Chrome or Edge executable not found");
  const browserPort = allocateCdpPort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "novalure-live-onboarding-"));
  const browserProcess = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${browserPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,720",
    "about:blank",
  ], { stdio: "ignore" });
  let client;
  try {
    await waitForJson(`http://127.0.0.1:${browserPort}/json/version`, 15000);
    const target = await openPageTarget(`${baseUrl}/login?lang=de`, browserPort);
    client = await createCdpClient(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await setViewport(client, 1280, 720, false);
    await waitFor(client, () => /Geschützter Novalure-Workspace|Gesch\u00c3\u00bctzter Novalure-Workspace/.test(document.body?.innerText ?? ""), "login page");
    return await saveScreenshot(client, "00-login-de.png");
  } finally {
    try {
      client?.close?.();
    } catch {
      // Ignore.
    }
    browserProcess.kill();
    await sleep(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Windows can keep the headless profile locked briefly after process shutdown.
    }
  }
}

async function main() {
  const productionEnv = parseEnvFile(productionEnvPath, true);
  const qaEnv = parseEnvFile(liveOnboardingEnvPath, true);
  const databaseUrl = getDatabaseUrl(productionEnv);
  assertLiveTarget(productionEnv, databaseUrl.value);
  const password = qaEnv.get("NOVALURE_ONBOARDING_PASSWORD");
  if (!password) throw new Error("Missing NOVALURE_ONBOARDING_PASSWORD.");
  const localBaseUrl = `http://127.0.0.1:${localPort}`;
  const sql = neon(databaseUrl.value);

  await sql.query(
    `
      update workspace_users
      set onboarding_completed_at = null,
          onboarding_current_step = null,
          onboarding_completed_steps = '{}',
          onboarding_skipped_steps = '{}',
          onboarding_dismissed_at = null,
          onboarding_role_context = null,
          updated_at = now()
      where lower(email) in ($1, $2, $3)
        and workspace_id in (select id from workspaces where name = 'CODEXTEST_ONBOARDING_LIVE')
    `,
    [users.owner, users.agent, users.viewer],
  );

  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(localPort)], {
    env: buildServerEnv(productionEnv),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  try {
    await waitForHttp(`${localBaseUrl}/login?lang=de`, 45000);

    const ownerLogin = await login(localBaseUrl, users.owner, password);
    if (ownerLogin.status !== 303 || !ownerLogin.cookie) throw new Error(`Owner login failed: ${ownerLogin.status}`);
    const ownerSession = await requestJson(localBaseUrl, "/api/auth/session", ownerLogin.cookie);
    const ownerStart = await requestJson(localBaseUrl, "/api/auth/onboarding", ownerLogin.cookie);
    const ownerStep = await requestJson(localBaseUrl, "/api/auth/onboarding", ownerLogin.cookie, {
      body: JSON.stringify({ action: "complete_step", stepId: "workspace_profile" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const ownerReload = await requestJson(localBaseUrl, "/api/auth/onboarding", ownerLogin.cookie);

    const agentLogin = await login(localBaseUrl, users.agent, password);
    if (agentLogin.status !== 303 || !agentLogin.cookie) throw new Error(`Agent login failed: ${agentLogin.status}`);
    const agentSession = await requestJson(localBaseUrl, "/api/auth/session", agentLogin.cookie);
    const agentForbiddenStep = await requestJson(localBaseUrl, "/api/auth/onboarding", agentLogin.cookie, {
      body: JSON.stringify({ action: "complete_step", stepId: "team_invite" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const agentForbiddenInvite = await requestJson(localBaseUrl, "/api/crm/customer-access", agentLogin.cookie, {
      body: JSON.stringify({
        operation: "invite_workspace_user",
        user: {
          email: "codextest-onboarding-agent-denied@example.test",
          name: "CODEXTEST Agent Denied",
          productRole: "viewer",
          role: "assistant",
        },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const viewerLogin = await login(localBaseUrl, users.viewer, password);
    if (viewerLogin.status !== 303 || !viewerLogin.cookie) throw new Error(`Viewer login failed: ${viewerLogin.status}`);
    const viewerSession = await requestJson(localBaseUrl, "/api/auth/session", viewerLogin.cookie);
    const viewerForbiddenContact = await requestJson(localBaseUrl, "/api/crm/contacts", viewerLogin.cookie, {
      body: JSON.stringify({ contact: { email: "codextest-onboarding-viewer-denied@example.test", name: "CODEXTEST Viewer Denied" } }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const invalidLogin = await login(localBaseUrl, "codextest-onboarding-invalid@novalure.local", "wrong-password");

    const screenshots = {
      loginDe: await captureLoginPage(localBaseUrl),
      loginErrorDe: await captureLoginError(localBaseUrl),
      ownerDesktop: await captureRole(localBaseUrl, users.owner, password, "02-owner-onboarding-desktop.png"),
      ownerMobile: await captureRole(localBaseUrl, users.owner, password, "03-owner-onboarding-mobile.png", true),
      agentDesktop: await captureRole(localBaseUrl, users.agent, password, "04-agent-onboarding-desktop.png"),
      viewerDesktop: await captureRole(localBaseUrl, users.viewer, password, "05-viewer-onboarding-desktop.png"),
      ownerStepPersisted: await captureRole(localBaseUrl, users.owner, password, "06-owner-step-persisted.png"),
      ownerResumeAfterReload: await captureRole(localBaseUrl, users.owner, password, "07-owner-resume-after-reload.png"),
    };

    const target = fingerprint(databaseUrl.value);
    console.log(JSON.stringify({
      ok: true,
      appUrl,
      localVerificationUrl: localBaseUrl,
      database: { database: mask(target.database), host: mask(target.host), user: mask(target.user) },
      auth: { demoAuth: false, strictAuth: true },
      checks: {
        invalidLogin: { status: invalidLogin.status, locationContainsInvalidCredentials: invalidLogin.location?.includes("invalid_credentials") ?? false },
        owner: {
          email: ownerSession.json?.user?.email,
          productRole: ownerSession.json?.user?.productRole,
          workspace: ownerSession.json?.workspace?.name,
          start: ownerStart.json,
          stepPersisted: ownerStep.status === 200 && ownerStep.json?.completedStepIds?.includes("workspace_profile"),
          reloadPersisted: ownerReload.json?.completedStepIds?.includes("workspace_profile"),
        },
        agent: {
          productRole: agentSession.json?.user?.productRole,
          forbiddenAdminStepStatus: agentForbiddenStep.status,
          forbiddenInviteStatus: agentForbiddenInvite.status,
        },
        viewer: {
          productRole: viewerSession.json?.user?.productRole,
          forbiddenContactStatus: viewerForbiddenContact.status,
        },
      },
      screenshots,
      serverOutputExcerpt: serverOutput.slice(-1000),
    }, null, 2));
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
