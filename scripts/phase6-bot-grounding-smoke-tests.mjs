import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("bot runtime blocks customer-facing answers without approved knowledge and creates a handoff", () => {
  const runtime = readText("src/lib/bots/chat-runtime.ts");

  assert.match(runtime, /const modelBlockedForKnowledge =/);
  assert.match(runtime, /customerFacing\s*&&\s*controls\.strictKnowledge\s*&&\s*!hasApprovedKnowledge/);
  assert.match(runtime, /policyBlockedReply\(\)/);
  assert.match(runtime, /humanHandoffRequired: requiresHumanHandoff/);
  assert.match(runtime, /updateBotConversationStatus/);
  assert.match(runtime, /status: "handoff"/);
  assert.match(runtime, /approved_knowledge_required/);
});

test("offline model fallback answers only from approved knowledge excerpts and exposes sources", () => {
  const provider = readText("src/lib/integrations/model-provider.ts");
  const runtime = readText("src/lib/bots/chat-runtime.ts");

  assert.match(provider, /approvedContext/);
  assert.match(provider, /source\.excerpt/);
  assert.match(provider, /offline-crm-grounded-reply/);
  assert.match(provider, /offline-crm-handoff-reply/);
  assert.match(provider, /prepare a handoff to the team/);
  assert.match(runtime, /appendRequiredCitations/);
  assert.match(runtime, /Quellen|Sources/);
});

test("bot command center reads persisted knowledge instead of relying only on static demo props", () => {
  const component = readText("src/components/bot-command-center.tsx");

  assert.match(component, /fetch\("\/api\/bots\/knowledge\?limit=50"\)/);
  assert.match(component, /knowledgeItemFromApi/);
  assert.match(component, /liveKnowledgeItems/);
  assert.match(component, /displayedKnowledgeItems/);
  assert.match(component, /approvedKnowledgeItems = displayedKnowledgeItems/);
});

test("QA seed contains a publishable grounded Seeblick bot and approved knowledge source", () => {
  const seed = readText("scripts/qa-livegang-seed.mjs");

  assert.match(seed, /QA Seeblick Sales Bot/);
  assert.match(seed, /strict_knowledge/);
  assert.match(seed, /'active'/);
  assert.match(seed, /Projektinfo Seeblick/);
  assert.match(seed, /Wohnung A-01/);
  assert.match(seed, /Wohnung B-12/);
  assert.match(seed, /approval: "approved"/);
});

test("bot policy continues to ban free internet browsing for customer answers", () => {
  const policy = readText("src/lib/bots/policy.ts");

  assert.match(policy, /internet_browsing_requested/);
  assert.match(policy, /cannot browse the internet/);
  assert.match(policy, /approved workspace or project knowledge/);
});
