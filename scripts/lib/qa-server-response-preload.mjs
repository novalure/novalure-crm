import assert from "node:assert/strict";
import { subscribe } from "node:diagnostics_channel";
import { observeQaServerResponse } from "./qa-server-response-capture.mjs";

const config = JSON.parse(process.env.CRM_QA_SERVER_RESPONSE_CAPTURE ?? "null");
delete process.env.CRM_QA_SERVER_RESPONSE_CAPTURE;
assert(config && config.syntheticOnly === true && /^[a-f0-9]{32}$/.test(config.runId) && /^[a-f0-9]{64}$/.test(config.secret));
assert(typeof process.send === "function" && process.connected);
const url = new URL(config.origin);
assert(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.origin === config.origin);
let id = 0, events = 0;
const emit = row => {
  assert(++events <= 20000);
  // Credential-derived fingerprints and body digests never enter a file/log.
  // Only the already owned native parent receives this bounded RAM message.
  process.send({ type: "crm.qa.server-capture/v1", row }, error => { if (error) process.exitCode = 1; });
};
subscribe("http.server.request.start", ({ request, response }) => {
  observeQaServerResponse(request, response, { ...config, id: ++id, emit });
});
