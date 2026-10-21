import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  extractWebsiteText, isPublicIpAddress, scanWebsite, validateWebsiteUrl, WebsiteScanError,
  type WebsiteScanPorts, type WebsiteScanResponse,
} from "../src/lib/knowledge-center/website-scanner";
import {
  KnowledgeBillingError, processStripeKnowledgeWebhook, verifyStripeKnowledgeSignature,
  type KnowledgeBillingPorts,
} from "../src/lib/knowledge-center/billing";

const publicAddress = { address: "93.184.215.14", family: 4 as const };
const page = (text = "<head><title>Company &amp; team</title></head><p>Opening hours 09:00–17:00</p>"): WebsiteScanResponse => ({
  status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(text),
});
const ports = (response: WebsiteScanResponse = page()): WebsiteScanPorts => ({
  resolve: async () => [publicAddress], request: async () => response,
});
const rejectsCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) =>
  error instanceof WebsiteScanError && error.code === code);

test("public address policy rejects IPv4 and IPv6 private, mapped, transition and reserved forms", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.10", "192.88.99.1", "192.168.0.1", "198.19.0.2", "198.51.100.2", "203.0.113.2",
    "224.1.2.3", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2001:0::1", "2001:db8::1", "2002:a00:1::", "3fff::1",
  ]) assert.equal(isPublicIpAddress(address), false, address);
  for (const address of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
});

test("URL policy blocks schemes, credentials, alternate ports, local aliases and obfuscated loopback", () => {
  for (const url of [
    "http://company.com", "file:///etc/passwd", "https://user:password@company.com", "https://company.com:444/",
    "https://localhost/", "https://foo.local/", "https://foo.internal/", "https://localhost./", "https://metadata/",
    "https://127.1/", "https://2130706433/", "https://0x7f000001/", "https://[::ffff:127.0.0.1]/",
    "https://company.com/\n", "https://a..com/", "https://a_b.com/",
  ]) assert.throws(() => validateWebsiteUrl(url), WebsiteScanError, url);
  assert.equal(validateWebsiteUrl("https://company.com:443/about#hours").href, "https://company.com/about");
});

test("mixed public/private DNS answers fail before any connection", async () => {
  let requests = 0;
  await rejectsCode(scanWebsite("https://company.com", { ports: {
    resolve: async () => [publicAddress, { address: "127.0.0.1", family: 4 }],
    request: async () => { requests += 1; return page(); },
  } }), "website_address_denied");
  assert.equal(requests, 0);
});

test("request receives the validated address and never resolves the hostname a second time", async () => {
  let resolutions = 0;
  const result = await scanWebsite("https://company.com/about", { ports: {
    resolve: async () => { resolutions += 1; return [publicAddress]; },
    request: async ({ address, url, signal, maxBytes }) => {
      assert.deepEqual(address, publicAddress);
      assert.equal(url.hostname, "company.com");
      assert.equal(signal.aborted, false);
      assert.equal(maxBytes, 1_000_000);
      return page();
    },
  } });
  assert.equal(resolutions, 1);
  assert.equal(result.title, "Company & team");
  assert.equal(result.text, "Opening hours 09:00–17:00");
  assert.equal(result.trust, "untrusted_external_content");
  assert.equal(result.change.requiresApproval, true);
});

test("redirects validate both URLs and fresh DNS on every hop", async () => {
  const hosts: string[] = [], requested: string[] = [];
  await rejectsCode(scanWebsite("https://company.com", { ports: {
    resolve: async (hostname) => { hosts.push(hostname); return hostname === "evil.com" ? [{ address: "10.0.0.1", family: 4 }] : [publicAddress]; },
    request: async ({ url }) => { requested.push(url.hostname); return { status: 302, headers: { location: "https://evil.com/" }, body: Buffer.from("") }; },
  } }), "website_address_denied");
  assert.deepEqual(hosts, ["company.com", "evil.com"]);
  assert.deepEqual(requested, ["company.com"]);
  for (const location of ["http://company.com/", "https://127.0.0.1/", "https://user@company.com/"]) {
    await assert.rejects(scanWebsite("https://company.com", { ports: ports({ status: 302, headers: { location }, body: Buffer.from("") }) }), WebsiteScanError);
  }
});

test("relative redirects are supported while redirect loops remain bounded", async () => {
  let requests = 0;
  const result = await scanWebsite("https://company.com/start", { ports: {
    ...ports(), request: async ({ url }) => {
      requests += 1;
      return url.pathname === "/start" ? { status: 301, headers: { location: "/contact" }, body: Buffer.from("") } : page();
    },
  } });
  assert.equal(result.finalUrl, "https://company.com/contact");
  assert.equal(requests, 2);
  await rejectsCode(scanWebsite("https://company.com", { limits: { maxRedirects: 1 }, ports: ports({ status: 302, headers: { location: "/" }, body: Buffer.from("") }) }), "website_redirect_limit");
});

test("same-host DNS rebinding after a redirect is rejected before the second connection", async () => {
  let resolutions = 0, requests = 0;
  await rejectsCode(scanWebsite("https://company.com", { ports: {
    resolve: async () => ++resolutions === 1 ? [publicAddress] : [{ address: "169.254.169.254", family: 4 }],
    request: async () => { requests += 1; return { status: 302, headers: { location: "/new" }, body: Buffer.from("") }; },
  } }), "website_address_denied");
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

test("DNS stalls and body stalls share a hard deadline and abort their port", async () => {
  for (const stall of ["dns", "body"]) {
    let observed: AbortSignal | undefined;
    const never = (signal: AbortSignal) => { observed = signal; return new Promise<never>(() => {}); };
    await rejectsCode(scanWebsite("https://company.com", { limits: { timeoutMs: 10 }, ports: {
      resolve: async (_hostname, signal) => stall === "dns" ? never(signal) : [publicAddress],
      request: async ({ signal }) => never(signal),
    } }), "website_scan_timeout");
    assert.equal(observed?.aborted, true);
  }
});

test("content types, encodings, status, byte and text limits fail closed", async () => {
  for (const [response, code] of [
    [{ ...page(), headers: { "content-type": "application/json" } }, "website_content_type_denied"],
    [{ ...page(), headers: { "content-type": "text/html", "content-encoding": "gzip" } }, "website_encoding_denied"],
    [{ ...page(), status: 401 }, "website_http_error"],
    [page(" "), "website_content_empty"],
  ] as const) await rejectsCode(scanWebsite("https://company.com", { ports: ports(response) }), code);
  await rejectsCode(scanWebsite("https://company.com", { ports: ports(page("12345")), limits: { maxBytes: 4 } }), "website_response_too_large");
  await rejectsCode(scanWebsite("https://company.com", { ports: ports(page("12345")), limits: { maxTextCharacters: 4 } }), "website_text_too_large");
  await rejectsCode(scanWebsite("https://company.com", { limits: { timeoutMs: 99_999 } }), "website_scan_limits_invalid");
});

test("HTML extraction is inert, excludes executable regions and handles malformed markup linearly", () => {
  const result = extractWebsiteText('<head><title>FAQ</title><style>secret</style></head><p>Open &amp; ready &#x1f44b;</p><!-- ignored --><script>fetch("https://internal/")</script><iframe>hidden</iframe><svg>hidden</svg><template>hidden</template>');
  assert.equal(result.title, "FAQ");
  assert.equal(result.text, "Open & ready 👋");
  assert.equal(extractWebsiteText("<".repeat(200_000)).text.length, 200_000);
  assert.equal(extractWebsiteText(`<${" ".repeat(200_000)}>safe`).text, "safe");
  assert.equal(extractWebsiteText('<script>no closing tag').text, "");
});

test("change detection yields approval proposals and never changes a published source", async () => {
  const first = await scanWebsite("https://company.com", { ports: ports() });
  assert.equal(first.change.kind, "initial");
  const persistedTextHash = createHash("sha256").update(first.text).digest("hex");
  assert.equal(first.contentHash, persistedTextHash);
  const same = await scanWebsite("https://company.com", { ports: ports(), previousHash: persistedTextHash });
  assert.equal(same.change.kind, "unchanged");
  const renamedPage = await scanWebsite("https://company.com", { ports: ports(page("<head><title>New page title</title></head><p>Opening hours 09:00–17:00</p>")), previousHash: persistedTextHash });
  assert.equal(renamedPage.change.kind, "unchanged", "page titles do not silently replace managed source names");
  const changed = await scanWebsite("https://company.com", { ports: ports(page("Different opening hours")), previousHash: first.contentHash });
  assert.equal(changed.change.kind, "changed");
  assert.equal(changed.change.previousHash, first.contentHash);
  assert.equal(changed.change.proposedHash, changed.contentHash);
  assert.equal(changed.change.requiresApproval, true);
});

test("network failures expose only a safe error code", async () => {
  await assert.rejects(scanWebsite("https://company.com", { ports: { ...ports(), request: async () => { throw new Error("secret upstream token"); } } }),
    (error: unknown) => error instanceof WebsiteScanError && error.message === "website_fetch_failed");
});

const secret = "whsec_synthetic_contract_test_only";
const nowSeconds = 1_790_000_000;
const workspaceId = "11111111-1111-4111-8111-111111111111";
function webhook(eventId = "evt_contract1", customerId = "cus_known") {
  const rawBody = Buffer.from(JSON.stringify({
    id: eventId, type: "customer.subscription.updated", created: nowSeconds, account: "acct_known",
    data: { object: { id: "sub_known", customer: customerId, status: "active", items: { data: [{ price: { id: "price_existing" } }] },
      metadata: { workspaceId: "22222222-2222-4222-8222-222222222222", enabled: true }, cancel_at_period_end: false } },
  }));
  const signature = `t=${nowSeconds},v1=${createHmac("sha256", secret).update(`${nowSeconds}.`).update(rawBody).digest("hex")}`;
  return { rawBody, signature, secret, nowSeconds };
}

test("Stripe signature requires the raw bytes, valid HMAC and a bounded timestamp", () => {
  const input = webhook();
  assert.doesNotThrow(() => verifyStripeKnowledgeSignature(input.rawBody, input.signature, secret, nowSeconds));
  assert.throws(() => verifyStripeKnowledgeSignature(Buffer.from("{}"), input.signature, secret, nowSeconds), KnowledgeBillingError);
  assert.throws(() => verifyStripeKnowledgeSignature(input.rawBody, input.signature, secret, nowSeconds + 301), KnowledgeBillingError);
  assert.throws(() => verifyStripeKnowledgeSignature(input.rawBody, `t=${nowSeconds},t=${nowSeconds},v1=${"0".repeat(64)}`, secret, nowSeconds), KnowledgeBillingError);
});

test("verified billing adapter maps the tenant from stored customer identity and delegates atomic idempotency", async () => {
  const receipts = new Map<string, string>();
  let writes = 0;
  const billingPorts: KnowledgeBillingPorts = {
    resolveTenant: async ({ customerId, accountId }) => {
      assert.equal(accountId, "acct_known");
      return customerId === "cus_known" ? { workspaceId } : null;
    },
    mapSubscription: async (subscription, resolvedWorkspaceId) => {
      assert.equal(resolvedWorkspaceId, workspaceId);
      assert.deepEqual(subscription.priceIds, ["price_existing"]);
      assert.equal("metadata" in subscription, false);
      return { enabled: true, contractReference: "contract_existing", features: {}, limits: { sources: 5 }, accessState: "active" };
    },
    applyVerifiedEventOnce: async (event) => {
      assert.equal(event.workspaceId, workspaceId);
      if (receipts.has(event.eventId)) {
        assert.equal(receipts.get(event.eventId), event.eventDigest);
        return "duplicate";
      }
      receipts.set(event.eventId, event.eventDigest); writes += 1; return "applied";
    },
    recordIgnoredEventOnce: async () => {},
  };
  assert.equal((await processStripeKnowledgeWebhook({ ...webhook(), ports: billingPorts })).outcome, "applied");
  assert.equal((await processStripeKnowledgeWebhook({ ...webhook(), ports: billingPorts })).outcome, "duplicate");
  assert.equal(writes, 1);
  await assert.rejects(processStripeKnowledgeWebhook({ ...webhook("evt_other", "cus_unknown"), ports: billingPorts }),
    (error: unknown) => error instanceof KnowledgeBillingError && error.code === "billing_customer_unmapped");
  assert.equal(writes, 1);
  await assert.rejects(processStripeKnowledgeWebhook({ ...webhook(), signature: "invalid", ports: billingPorts }), KnowledgeBillingError);
  assert.equal(writes, 1);
});
