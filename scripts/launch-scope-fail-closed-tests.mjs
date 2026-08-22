import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readProjectFile(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

test("unfinished global import is absent from header, mobile, quick actions, and modal reachability", () => {
  const workspace = readProjectFile("src/components/crm-workspace.tsx");

  assert.match(workspace, /const importLaunchEnabled = false/);
  assert.match(workspace, /actionId === "reviewImport"\) return importLaunchEnabled/);
  assert.match(workspace, /if \(!importLaunchEnabled\) return;/);
  assert.match(workspace, /importLaunchEnabled && actionModal === "import"/);
  assert.ok((workspace.match(/\{importLaunchEnabled \? \(/g) ?? []).length >= 2);
});

test("funnel outbound webhook is server-side launch-off and cannot claim readiness", () => {
  const writeRoute = readProjectFile("src/app/api/crm/funnels/route.ts");
  const repository = readProjectFile("src/lib/db/crm-write-repositories.ts");
  const adapter = readProjectFile("src/lib/funnel-builder-adapter.ts");
  const commandCenter = readProjectFile("src/components/funnel-command-center.tsx");
  const submissionRoute = readProjectFile("src/app/api/funnels/[funnelId]/submissions/route.ts");

  assert.match(writeRoute, /delete launchScopedFunnel\.webhookUrl/);
  assert.match(writeRoute, /funnelWebhookDelivery: "off"/);
  assert.match(repository, /tracking = \(tracking - 'webhookUrl'\) \|\| \$14::jsonb/);
  assert.doesNotMatch(adapter, /webhookUrl: funnel\.webhookUrl/);
  assert.match(commandCenter, /data-funnel-webhook-launch-scope="off"/);
  assert.doesNotMatch(commandCenter, /updateSelectedFunnel\(\{ webhookUrl:/);
  assert.match(submissionRoute, /webhookDelivery: "launch_off"/);
  assert.match(submissionRoute, /webhookReady: false/);
  assert.doesNotMatch(submissionRoute, /webhookReady: Boolean\(/);
});

test("newsletter delivery is visibly and server-side launch-off until replay-safe delivery exists", () => {
  const scope = readProjectFile("src/lib/newsletter-launch-scope.ts");
  const route = readProjectFile("src/app/api/newsletter/send/route.ts");
  const commandCenter = readProjectFile("src/components/newsletter-command-center.tsx");

  assert.match(scope, /newsletterDeliveryLaunchEnabled = false/);
  assert.match(route, /if \(!newsletterDeliveryLaunchEnabled\)/);
  assert.match(route, /NEWSLETTER_DELIVERY_LAUNCH_OFF/);
  assert.match(route, /cache-control": "private, no-store"/);
  assert.doesNotMatch(route, /from:\s*(?:input|body)\./);
  assert.ok(
    (commandCenter.match(/newsletterDeliveryLaunchEnabled \? \(/g) ?? []).length >= 2,
  );
  assert.ok(
    (commandCenter.match(/data-newsletter-delivery-launch-scope="off"/g) ?? []).length >= 2,
  );
});
