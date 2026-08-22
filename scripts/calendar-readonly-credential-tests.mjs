import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const tokenEncryptionKey = "calendar-readonly-test-key-with-more-than-32-bytes";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function transpile(path, input) {
  return ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
}

function encryptToken(value) {
  const iv = Buffer.alloc(12, 7);
  const key = createHash("sha256").update(tokenEncryptionKey).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

async function loadCalendarConnections({ expiresAt, launchAllowed = false }) {
  const path = "src/lib/integrations/calendar-connections.ts";
  const counters = { databaseReads: 0, databaseWrites: 0, providerRequests: 0 };
  const row = {
    accountLabel: "workspace-calendar@example.invalid",
    config: {
      accessToken: encryptToken("workspace-access-token"),
      refreshToken: encryptToken("workspace-refresh-token"),
    },
    error: null,
    expiresAt,
    scopes: ["calendar.read"],
    status: "connected",
  };
  const cjsModule = { exports: {} };
  const moduleRequire = (specifier) => {
    if (specifier === "node:crypto") return require(specifier);
    if (specifier === "@/lib/db/client") {
      return {
        executeQuery: async () => {
          counters.databaseWrites += 1;
        },
        hasDatabaseUrl: () => true,
        queryOne: async () => {
          counters.databaseReads += 1;
          return row;
        },
      };
    }
    if (specifier === "@/lib/db/runtime-repositories") return { isUuid: () => true };
    if (specifier === "@/lib/integrations/calendar-oauth-state") {
      return {
        createSignedOAuthState: () => {
          throw new Error("not used");
        },
        decryptOAuthStateSecret: () => "not-used",
        encryptOAuthStateSecret: () => "not-used",
        hashOAuthState: () => "not-used",
        parseSignedOAuthState: () => null,
      };
    }
    if (specifier === "@/lib/launch-scope") {
      return {
        evaluateLaunchScope: () => launchAllowed
          ? { allowed: true, decision: "LAUNCH-ON", rule: {} }
          : { allowed: false, code: "LAUNCH_SCOPE_OFF", decision: "LAUNCH-OFF", rule: {} },
      };
    }
    return require(specifier);
  };
  const providerFetch = async () => {
    counters.providerRequests += 1;
    return {
      json: async () => ({ access_token: "refreshed-access-token", expires_in: 3600 }),
      ok: true,
      status: 200,
    };
  };

  vm.runInNewContext(
    transpile(path, await source(path)),
    {
      Buffer,
      Date,
      Error,
      JSON,
      Math,
      Number,
      Object,
      Promise,
      URL,
      URLSearchParams,
      console,
      exports: cjsModule.exports,
      fetch: providerFetch,
      module: cjsModule,
      process,
      require: moduleRequire,
    },
    { filename: path },
  );

  return { counters, module: cjsModule.exports };
}

async function loadBusyAdapter(path, { readToken }) {
  const counters = { mutationTokenCalls: 0, providerRequests: 0, readTokenCalls: 0 };
  const requests = [];
  const cjsModule = { exports: {} };
  const moduleRequire = (specifier) => {
    if (specifier === "@/lib/integrations/calendar-connections") {
      return {
        calendarProviderReadUnavailableCode: "calendar_provider_read_unavailable",
        getCalendarAccessToken: async () => {
          counters.mutationTokenCalls += 1;
          return "mutation-token-must-not-be-used";
        },
        getCalendarReadAccessToken: async () => {
          counters.readTokenCalls += 1;
          return readToken;
        },
      };
    }
    if (specifier === "@/lib/launch-scope") {
      return {
        evaluateLaunchScope: () => ({
          allowed: false,
          code: "LAUNCH_SCOPE_OFF",
          decision: "LAUNCH-OFF",
          rule: {},
        }),
      };
    }
    if (specifier === "@/lib/meetings/booking-lifecycle") {
      return { createProviderEventKey: () => "not-used" };
    }
    return require(specifier);
  };
  const providerFetch = async (url, init = {}) => {
    counters.providerRequests += 1;
    requests.push({ headers: init.headers ?? {}, method: init.method ?? "GET", url: String(url) });
    return {
      json: async () => path.includes("google-calendar")
        ? { calendars: { primary: { busy: [] } } }
        : { value: [] },
      ok: true,
      status: 200,
    };
  };

  vm.runInNewContext(
    transpile(path, await source(path)),
    {
      Error,
      JSON,
      Object,
      Promise,
      URL,
      URLSearchParams,
      console,
      exports: cjsModule.exports,
      fetch: providerFetch,
      module: cjsModule,
      process,
      require: moduleRequire,
    },
    { filename: path },
  );

  return { counters, module: cjsModule.exports, requests };
}

test("expired workspace credentials stay read-only while calendar provider mutation is launch-off", async () => {
  const previousKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = tokenEncryptionKey;

  try {
    const loaded = await loadCalendarConnections({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    assert.equal(
      await loaded.module.getCalendarReadAccessToken({ provider: "google", workspaceId }),
      null,
    );
    assert.equal(
      await loaded.module.getCalendarAccessToken({ provider: "google", workspaceId }),
      null,
    );
    assert.equal(loaded.counters.databaseReads, 2);
    assert.equal(loaded.counters.providerRequests, 0);
    assert.equal(loaded.counters.databaseWrites, 0);
  } finally {
    if (previousKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});

test("a still-valid workspace token remains available without refresh or persistence", async () => {
  const previousKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = tokenEncryptionKey;

  try {
    const loaded = await loadCalendarConnections({
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    assert.equal(
      await loaded.module.getCalendarReadAccessToken({ provider: "microsoft", workspaceId }),
      "workspace-access-token",
    );
    assert.equal(loaded.counters.databaseReads, 1);
    assert.equal(loaded.counters.providerRequests, 0);
    assert.equal(loaded.counters.databaseWrites, 0);
  } finally {
    if (previousKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});

test("workspace busy-time reads never fall back to global Microsoft credentials", async () => {
  const previousValues = {
    accessToken: process.env.MICROSOFT_GRAPH_ACCESS_TOKEN,
    calendarUser: process.env.MICROSOFT_CALENDAR_USER_ID,
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenantId: process.env.MICROSOFT_TENANT_ID,
  };
  process.env.MICROSOFT_GRAPH_ACCESS_TOKEN = "global-token-must-not-be-used";
  process.env.MICROSOFT_CALENDAR_USER_ID = "global-calendar-user-must-not-be-used";
  process.env.MICROSOFT_CLIENT_ID = "global-client-id";
  process.env.MICROSOFT_CLIENT_SECRET = "global-client-secret";
  process.env.MICROSOFT_TENANT_ID = "global-tenant";

  try {
    const microsoft = await loadBusyAdapter("src/lib/integrations/microsoft-calendar.ts", {
      readToken: null,
    });

    await assert.rejects(
      microsoft.module.listMicrosoftBusyTimes({
        timeMax: "2026-08-23T11:00:00.000Z",
        timeMin: "2026-08-23T10:00:00.000Z",
        workspaceId,
      }),
      /calendar_provider_read_unavailable/,
    );
    assert.equal(microsoft.counters.readTokenCalls, 1);
    assert.equal(microsoft.counters.mutationTokenCalls, 0);
    assert.equal(microsoft.counters.providerRequests, 0);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      const envKey = {
        accessToken: "MICROSOFT_GRAPH_ACCESS_TOKEN",
        calendarUser: "MICROSOFT_CALENDAR_USER_ID",
        clientId: "MICROSOFT_CLIENT_ID",
        clientSecret: "MICROSOFT_CLIENT_SECRET",
        tenantId: "MICROSOFT_TENANT_ID",
      }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test("busy-time adapters use valid workspace tokens without a mutation token path", async () => {
  const previousGlobalToken = process.env.MICROSOFT_GRAPH_ACCESS_TOKEN;
  process.env.MICROSOFT_GRAPH_ACCESS_TOKEN = "global-token-must-not-be-used";

  try {
    const [google, microsoft] = await Promise.all([
      loadBusyAdapter("src/lib/integrations/google-calendar.ts", { readToken: "google-workspace-token" }),
      loadBusyAdapter("src/lib/integrations/microsoft-calendar.ts", { readToken: "microsoft-workspace-token" }),
    ]);

    await google.module.listGoogleBusyTimes({
      timeMax: "2026-08-23T11:00:00.000Z",
      timeMin: "2026-08-23T10:00:00.000Z",
      timeZone: "Europe/Vienna",
      workspaceId,
    });
    await microsoft.module.listMicrosoftBusyTimes({
      timeMax: "2026-08-23T11:00:00.000Z",
      timeMin: "2026-08-23T10:00:00.000Z",
      workspaceId,
    });

    for (const adapter of [google, microsoft]) {
      assert.equal(adapter.counters.readTokenCalls, 1);
      assert.equal(adapter.counters.mutationTokenCalls, 0);
      assert.equal(adapter.counters.providerRequests, 1);
    }
    assert.match(google.requests[0].url, /googleapis\.com\/calendar\/v3\/freeBusy/);
    assert.equal(google.requests[0].headers.Authorization, "Bearer google-workspace-token");
    assert.match(microsoft.requests[0].url, /graph\.microsoft\.com\/v1\.0\/me\/calendarView/);
    assert.equal(microsoft.requests[0].headers.Authorization, "Bearer microsoft-workspace-token");
    assert.doesNotMatch(JSON.stringify(microsoft.requests), /global-token-must-not-be-used/);
  } finally {
    if (previousGlobalToken === undefined) delete process.env.MICROSOFT_GRAPH_ACCESS_TOKEN;
    else process.env.MICROSOFT_GRAPH_ACCESS_TOKEN = previousGlobalToken;
  }
});

test("source contracts keep refresh and persistence fenced while status routes remain read-only", async () => {
  const [connections, google, microsoft, oauthStatus] = await Promise.all([
    source("src/lib/integrations/calendar-connections.ts"),
    source("src/lib/integrations/google-calendar.ts"),
    source("src/lib/integrations/microsoft-calendar.ts"),
    source("src/app/api/meetings/oauth/status/route.ts"),
  ]);
  const accessTokenRead = connections.slice(
    connections.indexOf("export async function getCalendarReadAccessToken"),
    connections.indexOf("function getUsableStoredCalendarAccessToken"),
  );
  const refresh = connections.slice(
    connections.indexOf("async function refreshCalendarAccessToken"),
    connections.indexOf("async function refreshGoogleToken"),
  );
  const refreshGuard = refresh.indexOf('evaluateLaunchScope("calendarProviderMutation")');
  const providerRequest = Math.min(
    ...["refreshGoogleToken(", "refreshMicrosoftToken("].map((marker) => refresh.indexOf(marker)).filter((index) => index >= 0),
  );
  const databaseWrite = refresh.indexOf("await executeQuery(");

  assert.doesNotMatch(accessTokenRead, /refreshCalendarAccessToken|executeQuery|postToken/);
  assert.ok(refreshGuard >= 0 && refreshGuard < providerRequest && refreshGuard < databaseWrite);
  assert.ok((refresh.match(/evaluateLaunchScope\("calendarProviderMutation"\)/g) ?? []).length >= 2);

  const googleBusy = google.slice(
    google.indexOf("export async function listGoogleBusyTimes"),
    google.indexOf("export async function updateGoogleCalendarEvent"),
  );
  const microsoftBusy = microsoft.slice(
    microsoft.indexOf("export async function listMicrosoftBusyTimes"),
    microsoft.indexOf("export async function updateMicrosoftCalendarEvent"),
  );
  const workspaceGraphBranch = microsoft.slice(
    microsoft.indexOf("if (workspaceId)"),
    microsoft.indexOf("const directToken"),
  );

  assert.match(googleBusy, /getCalendarReadAccessToken/);
  assert.doesNotMatch(googleBusy, /getCalendarAccessToken/);
  assert.match(microsoftBusy, /getGraphToken\(input\.workspaceId\)/);
  assert.match(workspaceGraphBranch, /getCalendarReadAccessToken/);
  assert.match(workspaceGraphBranch, /return null/);
  assert.doesNotMatch(workspaceGraphBranch, /MICROSOFT_GRAPH_ACCESS_TOKEN|MICROSOFT_CALENDAR_USER_ID/);
  assert.match(oauthStatus, /getCalendarConnectionStatus/);
  assert.doesNotMatch(oauthStatus, /getCalendarAccessToken|fetch\(|executeQuery|evaluateLaunchScope/);
});
