import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { crmBots, crmBotConversations } from "../src/lib/crm-data";
import { getBotCommandCenterCopy } from "../src/lib/i18n";
import { BotCommandCenter, botLivePresentation, readBotSource, botWorkspaceUrl, configuredEvaluationChannels, knowledgeItemFromApi, knowledgeItemsFromSnapshot } from "../src/components/bot-command-center";
import type { CrmBotChannelConfig } from "../src/lib/crm-types";
import type { KnowledgeSource } from "../src/lib/knowledge-center/types";

const source: KnowledgeSource = { id:"source",areaId:"area",projectId:null,name:"Approved company FAQ",type:"faq",
  status:"approved",revision:1,approvedVersionId:"published",draftVersionId:null,archivedAt:null,
  version:{id:"published",sourceId:"source",version:1,name:"Approved company FAQ",content:"Approved source content",
    structuredData:{},url:null,mediaAssetId:null,processingStatus:"manual",processingMessage:null,processingFormat:null,status:"approved",createdAt:"2026-10-19T00:00:00Z",approvedAt:"2026-10-19T00:00:00Z"} };
const channel = (name: CrmBotChannelConfig["channel"],active = true): CrmBotChannelConfig => ({id:name,channel:name,active,
  greetingEn:"",greetingDe:"",handoffRules:[],businessHours:"",language:"auto",targetTeam:""});

test("Knowledge Center response names and publication references replace removed legacy chunk fields",()=>{
  const item=knowledgeItemFromApi(source);
  assert.equal(item.name,"Approved company FAQ");
  assert.equal(item.published,true);assert.equal(item.status,"approved");
  assert.equal("items" in item,false);assert.equal("coverage" in item,false);
});

test("a pending draft is labelled for review while the existing published source remains counted",()=>{
  const item=knowledgeItemFromApi({...source,name:"Pending draft title",status:"needs-review",draftVersionId:"draft",
    version:{...source.version!,id:"draft",status:"draft",approvedAt:null}});
  assert.equal(item.name,"Pending draft title");assert.equal(item.published,true);assert.equal(item.status,"needs-review");
  assert.equal(knowledgeItemFromApi({...source,approvedVersionId:null}).published,false,"a status label cannot invent a publication reference");
});

test("empty, disabled and unavailable persisted knowledge snapshots remain empty",()=>{
  assert.deepEqual(knowledgeItemsFromSnapshot({available:true,sources:[]}),[]);
  assert.deepEqual(knowledgeItemsFromSnapshot({available:false,sources:[source]}),[]);
  assert.deepEqual(knowledgeItemsFromSnapshot(null),[]);
  assert.equal(knowledgeItemsFromSnapshot({available:true,sources:[source]})[0].name,source.name);
});

test("evaluation channel selection uses active saved channels and never invents an internal grant",()=>{
  const configured=configuredEvaluationChannels({channels:[channel("Website Bot"),channel("Webchat"),channel("WhatsApp"),
    channel("Facebook Messenger"),channel("E-Mail"),channel("Email"),channel("Telefon"),channel("Voice"),
    channel("Instagram",false),channel("API/Webhook"),channel("Slack/Teams")]});
  assert.deepEqual(configured.map(item=>item.channel),["webchat","whatsapp","messenger","email","telephone","voice"]);
  assert.equal(configured[0].label,"Website Bot");
  assert.deepEqual(configuredEvaluationChannels({channels:[]}),[]);
  assert.deepEqual(configuredEvaluationChannels({channels:[channel("API/Webhook"),channel("Webchat",false)]}),[]);
});


test("workspace-scoped bot URLs carry the selected workspace for new knowledge, evaluation and history",()=>{
  assert.equal(botWorkspaceUrl("/api/bots/knowledge?limit=50","workspace-B"),"/api/bots/knowledge?limit=50&workspaceId=workspace-B");
  assert.equal(botWorkspaceUrl("/api/bots/evaluations","workspace-B"),"/api/bots/evaluations?workspaceId=workspace-B");
  assert.equal(botWorkspaceUrl("/api/bots/chat?limit=12","workspace-A"),"/api/bots/chat?limit=12&workspaceId=workspace-A");
  assert.equal(botWorkspaceUrl("/api/bots/agent","workspace-B"),"/api/bots/agent?workspaceId=workspace-B");
});


test("changing selected workspace remounts the bot center with fresh local state",()=>{
  const workspace = readFileSync(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<BotCommandCenter\s+key=\{activeWorkspace.id\}\s+workspaceId=\{activeWorkspace.id\}/);
});


test("unloaded or failed bot sources never report zero queues, cleared approvals or stale conversations", () => {
  const persisted = {
    liveConversations: [{ id: "live", title: "Actual conversation", status: "open", updatedAt: "2026-10-19T00:00:00Z", source: "live" as const }],
    approvals: [{ id: "approval", entityType: "bot", action: "send_document", summary: "Needs review", status: "pending", createdAt: "2026-10-19T00:00:00Z" }],
    documentSends: [{ id: "document", channel: "webchat", createdAt: "2026-10-19T00:00:00Z", documentName: "Document", status: "queued" }],
    meetingBookings: [],
  };
  for (const status of ["loading", "error"] as const) {
    const result = botLivePresentation({ ...persisted, liveStatus: status, approvalLoadStatus: status, botActionStatus: status });
    assert.deepEqual(result.displayConversations, [], "previously loaded rows are not presented as current data");
    assert.equal(result.pendingApprovalCount, null);
    assert.equal(result.openConversationCount, null);
    assert.equal(result.openBotActionCount, null);
    assert.equal(result.approvalsReady, false, "an unknown approval queue cannot clear publication readiness");
  }
  const loaded = botLivePresentation({ ...persisted, liveStatus: "ready", approvalLoadStatus: "ready", botActionStatus: "ready" });
  assert.equal(loaded.pendingApprovalCount, 1);
  assert.equal(loaded.openConversationCount, 1);
  assert.equal(loaded.openBotActionCount, 1);
  assert.equal(loaded.approvalsReady, false);
});

test("a confirmed empty API result stays empty and only its approval queue is cleared", () => {
  const result = botLivePresentation({ liveStatus: "ready", approvalLoadStatus: "ready", botActionStatus: "ready",
    liveConversations: [{ id: "legacy", title: "Legacy fixture", status: "open", updatedAt: "2026-10-19T00:00:00Z", source: "demo" }],
    approvals: [], documentSends: [], meetingBookings: [] });
  assert.deepEqual(result.displayConversations, []);
  assert.equal(result.pendingApprovalCount, 0);
  assert.equal(result.openConversationCount, 0);
  assert.equal(result.openBotActionCount, 0);
  assert.equal(result.approvalsReady, true);
});

test("initial bot rendering keeps loading states honest and ignores compatible legacy conversation props", () => {
  for (const language of ["de", "en"] as const) {
    const text = getBotCommandCenterCopy(language);
    const html = renderToStaticMarkup(createElement(BotCommandCenter, {
      workspaceId: "selected-workspace", language, projectLabel: "Selected project", canManageBotSetup: false,
      automations: [], bots: [{ ...crmBots[0], status: "active" }], callInsights: [],
      conversations: crmBotConversations, knowledgeItems: [], tools: [], workflows: [],
    }));
    assert.ok(html.includes(text.loadingLiveData));
    assert.ok(html.includes(text.loadingApprovals));
    assert.ok(!html.includes(text.demoData), "loading must not be labelled as demo fallback");
    for (const conversation of crmBotConversations) assert.ok(!html.includes(conversation.title));
    assert.match(html, new RegExp(`${text.approvals}</p><p[^>]*>—</p>`));
    assert.match(html, new RegExp(`${text.openConversations}</p><p[^>]*>—</p>`));
    assert.ok(!html.includes(text.noConversations), "unknown source is not a confirmed empty inbox");
  }
});


test("reader failures are isolated while workspace-scoped siblings retain actual database data", async () => {
  const urls: string[] = [];
  const payloads: Record<string, unknown> = {
    "/api/bots/chat": { source: "database", conversations: [{ id: "live", title: "Real inbox", status: "open", updatedAt: "2026-10-19T00:00:00Z" }] },
    "/api/bots/channels": { source: "database", recentWebhookEvents: [], policyRules: [], autonomyControls: { killSwitch: false, requireHumanApproval: true, strictKnowledge: true, testMode: false } },
    "/api/bots/actions": { source: "database", documentSends: [], meetingBookings: [] },
    "/api/bots/knowledge": { source: "database", available: true, sources: [source] },
  };
  const fetcher = async (url: string) => {
    urls.push(url);
    const path = new URL(url, "http://localhost").pathname;
    return path === "/api/approvals" || path === "/api/bots/documents"
      ? Response.json({ error: "Forbidden" }, { status: 403 })
      : Response.json(payloads[path]);
  };
  const [chat, channels, approvals, actions, documents, knowledge] = await Promise.all([
    readBotSource("chat", "workspace-B", fetcher), readBotSource("channels", "workspace-B", fetcher),
    readBotSource("approvals", "workspace-B", fetcher), readBotSource("actions", "workspace-B", fetcher),
    readBotSource("documents", "workspace-B", fetcher), readBotSource("knowledge", "workspace-B", fetcher),
  ]);
  assert.equal(chat.status, "ready");
  if (chat.status === "ready") assert.equal(chat.data.conversations?.[0].title, "Real inbox");
  assert.equal(channels.status, "ready");
  assert.equal(actions.status, "ready");
  assert.equal(knowledge.status, "ready");
  assert.equal(approvals.status, "error");
  assert.equal(documents.status, "error");
  for (const url of urls.filter((value) => !value.startsWith("/api/bots/documents"))) {
    assert.equal(new URL(url, "http://localhost").searchParams.get("workspaceId"), "workspace-B");
  }
  assert.ok(urls.includes("/api/bots/documents"), "the unrelated legacy document contract is unchanged");
});

test("malformed or non-database reader responses stay unknown, while confirmed database empties are ready", async () => {
  for (const kind of ["chat", "channels", "approvals", "actions", "documents", "knowledge"] as const) {
    assert.equal((await readBotSource(kind, "workspace-A", async () => Response.json({ source: "database" }))).status, "error", `${kind} requires its real response fields`);
    assert.equal((await readBotSource(kind, "workspace-A", async () => new Response("not-json"))).status, "error");
    assert.equal((await readBotSource(kind, "workspace-A", async () => { throw new Error("network unavailable"); })).status, "error");
  }
  assert.equal((await readBotSource("chat", "workspace-A", async () => Response.json({ source: "demo", conversations: [] }))).status, "error");
  assert.equal((await readBotSource("chat", "workspace-A", async () => Response.json({ source: "database", conversations: [{ id: "bad", title: "bad", status: "open", updatedAt: "now", latestMessageContent: {} }] }))).status, "error");
  assert.equal((await readBotSource("approvals", "workspace-A", async () => Response.json({ source: "database", approvals: [] }))).status, "ready");
  assert.equal((await readBotSource("actions", "workspace-A", async () => Response.json({ source: "database", documentSends: [], meetingBookings: [] }))).status, "ready");
  assert.equal((await readBotSource("knowledge", "workspace-A", async () => Response.json({ source: "database", available: false, sources: [] }))).status, "ready", "an explicitly disabled module is distinguished from an unavailable source");
});
