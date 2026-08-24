const automationBypassQueryKey = "x-vercel-protection-bypass";
const automationBypassTokenPattern = /^[A-Za-z0-9_-]{20,512}$/u;
const bindings = new WeakMap();
const productionHosts = new Set([
  "novalure-crm.app",
  "www.novalure-crm.app",
  "novalure-crm.vercel.app",
  "novalure-crm-novalure.vercel.app",
]);

function invalidAccess() {
  throw new Error("Vercel Preview automation access is invalid.");
}

function parseExactPreviewOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidAccess();
  }
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== value
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
    || !parsed.hostname.endsWith(".vercel.app")
    || productionHosts.has(parsed.hostname.toLowerCase())
  ) {
    invalidAccess();
  }
  return parsed;
}

function parseAutomationBypassUrl(value, previewOrigin) {
  const preview = parseExactPreviewOrigin(previewOrigin);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidAccess();
  }
  const entries = [...parsed.searchParams.entries()];
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== preview.origin
    || parsed.pathname !== "/"
    || parsed.hash
    || parsed.username
    || parsed.password
    || value !== parsed.toString()
    || entries.length !== 1
    || entries[0][0] !== automationBypassQueryKey
    || !automationBypassTokenPattern.test(entries[0][1])
  ) {
    invalidAccess();
  }
  return { origin: preview.origin, token: entries[0][1] };
}

export function validateVercelAutomationBypassUrl(value, previewOrigin) {
  const parsed = parseAutomationBypassUrl(value, previewOrigin);
  return Object.freeze({
    mode: "AUTOMATION_BYPASS",
    origin: parsed.origin,
    requestUrl: `${parsed.origin}/`,
  });
}

export function bindVercelAutomationBypass(target, value, previewOrigin) {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    invalidAccess();
  }
  const parsed = parseAutomationBypassUrl(value, previewOrigin);
  bindings.set(target, Object.freeze({ origin: parsed.origin, token: parsed.token }));
  return Object.freeze({
    mode: "AUTOMATION_BYPASS",
    origin: parsed.origin,
    requestUrl: `${parsed.origin}/`,
  });
}

export function hasVercelAutomationBypass(target) {
  return bindings.has(target);
}

export function applyVercelAutomationBypass(target, requestUrl, headers) {
  const binding = bindings.get(target);
  if (!binding) return false;
  let parsed;
  try {
    parsed = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  } catch {
    invalidAccess();
  }
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== binding.origin
    || parsed.username
    || parsed.password
    || parsed.hash
    || !(headers instanceof Headers)
  ) {
    invalidAccess();
  }
  headers.set(automationBypassQueryKey, binding.token);
  return true;
}
