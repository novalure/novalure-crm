"use client";

import { useEffect, useState, type ReactNode } from "react";
import type {
  Automation,
  BotCallInsight,
  BotEvaluationRun,
  BotLeadWorkflow,
  CrmBot,
  CrmBotConversation,
  CrmBotTool,
  KnowledgeItem,
} from "@/lib/crm-types";
import {
  formatNumber,
  getBotCommandCenterCopy,
  type LanguageCode,
} from "@/lib/i18n";

type BotCommandCenterProps = {
  automations: Automation[];
  bots: CrmBot[];
  callInsights: BotCallInsight[];
  conversations: CrmBotConversation[];
  knowledgeItems: KnowledgeItem[];
  language: LanguageCode;
  projectLabel: string;
  testPanel?: ReactNode;
  tools: CrmBotTool[];
  workflows: BotLeadWorkflow[];
};

type BotTab =
  | "overview"
  | "inbox"
  | "setup"
  | "knowledge"
  | "automations"
  | "testPublish";

type LiveBotConversation = {
  id: string;
  title: string;
  status: "open" | "handoff" | "resolved" | string;
  projectId?: string | null;
  botId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  updatedAt: string;
  latestMessage?: {
    role: "system" | "user" | "assistant" | "tool" | string;
    content: string;
    createdAt?: string | null;
    metadata?: unknown;
  } | null;
  source: "live" | "demo";
};

type BotRunSummary = {
  approvalId?: string | null;
  documentRequested?: boolean;
  humanHandoffRequired?: boolean;
  humanApprovalRequired?: boolean;
  meetingRequested?: boolean;
  nextAction?: string;
  score?: number | null;
};

type ApprovalDecision = "approved" | "denied" | "handoff";

type BotApproval = {
  id: string;
  entityType: string;
  entityId?: string | null;
  action: string;
  summary: string;
  status: string;
  payload?: unknown;
  createdAt: string;
};

type LiveChatApiResponse = {
  conversations?: Array<{
    id: string;
    title: string;
    status: string;
    projectId?: string | null;
    botId?: string | null;
    contactId?: string | null;
    leadId?: string | null;
    updatedAt: string;
    latestMessageRole?: "system" | "user" | "assistant" | "tool" | null;
    latestMessageContent?: string | null;
    latestMessageCreatedAt?: string | null;
    latestMessageMetadata?: unknown;
  }>;
  source?: string;
};

type ApprovalsApiResponse = {
  approvals?: BotApproval[];
  source?: string;
  status?: string;
};

type ApprovalDecisionResponse = {
  executedActions?: {
    documentSendsCreated?: number;
    meetingBookingsCreated?: number;
    meetingProposalsPrepared?: number;
  };
  updatedToolCalls?: number;
};

type BotActionDocumentSend = {
  id: string;
  channel: string;
  conversationId?: string | null;
  conversationTitle?: string | null;
  createdAt: string;
  documentName: string;
  mediaAssetId?: string | null;
  mediaAssetIsPublic?: boolean | null;
  mediaAssetMimeType?: string | null;
  metadata?: unknown;
  mediaAssetName?: string | null;
  mediaAssetPublicToken?: string | null;
  mediaAssetPublicUrl?: string | null;
  mediaAssetUrl?: string | null;
  sentAt?: string | null;
  status: string;
};

type BotDocumentAsset = {
  id: string;
  name: string;
  folder: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  isPublic?: boolean;
  publicUrl?: string | null;
};

type BotActionMeetingBooking = {
  id: string;
  contactEmail: string;
  contactName: string;
  createdAt: string;
  endsAt: string;
  slug: string;
  startsAt: string;
  status: string;
  title: string;
};

type BotActionsApiResponse = {
  documentSends?: BotActionDocumentSend[];
  meetingBookings?: BotActionMeetingBooking[];
  metrics?: {
    openDocuments?: number;
    openMeetings?: number;
  };
  source?: string;
};

type BotDocumentsApiResponse = {
  assets?: BotDocumentAsset[];
  quota?: {
    limitBytes: number;
    maxFileBytes: number;
    remainingBytes: number;
    usedBytes: number;
  };
};

type BotEvaluationsApiResponse = {
  runs?: BotEvaluationRun[];
  source?: string;
};

type KnowledgeApiResponse = {
  sources?: Array<{
    chunkCount?: number;
    embeddedChunkCount?: number;
    id: string;
    itemCount?: number;
    projectId?: string | null;
    status: string;
    title: string;
  }>;
  source?: string;
};

type BotSetupMutationResponse = {
  blockers?: string[];
  error?: string;
};

type BotActionMutationResponse = {
  documentSend?: BotActionDocumentSend;
  meetingBooking?: BotActionMeetingBooking;
  status?: string;
};

type ChannelApiResponse = {
  autonomyControls?: {
    disabledReason?: string | null;
    killSwitch: boolean;
    requireHumanApproval: boolean;
    strictKnowledge: boolean;
    testMode: boolean;
  };
  policyRules?: Array<{
    effect: "allow" | "block" | "test";
    id: string;
    label: string;
  }>;
  recentWebhookEvents?: Array<{
    id: string;
    channel: string;
    contactRef?: string | null;
    eventType: string;
    normalizedMessage?: {
      text?: string;
    } | null;
    receivedAt: string;
    status: string;
  }>;
};

const statusStyles: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  approved: "bg-emerald-100 text-emerald-800",
  Bereit: "bg-emerald-100 text-emerald-800",
  blocked: "bg-rose-100 text-rose-800",
  cancelled: "bg-rose-100 text-rose-800",
  confirmed: "bg-emerald-100 text-emerald-800",
  connected: "bg-emerald-100 text-emerald-800",
  denied: "bg-rose-100 text-rose-800",
  draft: "bg-stone-100 text-stone-700",
  error: "bg-rose-100 text-rose-800",
  expired: "bg-stone-100 text-stone-700",
  failed: "bg-rose-100 text-rose-800",
  Geplant: "bg-slate-100 text-slate-700",
  handoff: "bg-violet-100 text-violet-800",
  needs_review: "bg-amber-100 text-amber-800",
  not_connected: "bg-stone-100 text-stone-600",
  open: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-800",
  pending: "bg-amber-100 text-amber-800",
  queued: "bg-amber-100 text-amber-800",
  ready: "bg-blue-100 text-blue-800",
  ready_to_send: "bg-blue-100 text-blue-800",
  requested: "bg-amber-100 text-amber-800",
  resolved: "bg-slate-100 text-slate-700",
  sent: "bg-emerald-100 text-emerald-800",
  test: "bg-blue-100 text-blue-800",
  Training: "bg-blue-100 text-blue-800",
  Verbinden: "bg-blue-100 text-blue-800",
};

function Pill({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "green" | "blue" | "amber" | "rose";
}) {
  const tones = {
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-blue-100 text-blue-800",
    green: "bg-emerald-100 text-emerald-800",
    rose: "bg-rose-100 text-rose-800",
    slate: "bg-slate-100 text-slate-700",
  };

  return (
    <span className={`inline-flex max-w-full whitespace-normal break-words rounded-md px-2 py-1 text-left text-xs font-semibold leading-snug ${tones[tone]}`}>
      {children}
    </span>
  );
}

function StatusPill({ label, status }: { label: string; status: string }) {
  return (
    <span className={`inline-flex max-w-full whitespace-normal break-words rounded-md px-2 py-1 text-left text-xs font-semibold leading-snug ${statusStyles[status] ?? statusStyles.draft}`}>
      {label}
    </span>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getBotRunSummary(conversation: LiveBotConversation): BotRunSummary | null {
  const metadata = conversation.latestMessage?.metadata;

  if (!isRecord(metadata) || !isRecord(metadata.botRunSummary)) {
    return null;
  }

  return metadata.botRunSummary as BotRunSummary;
}

function getApprovalPayload(approval: BotApproval) {
  return isRecord(approval.payload) ? approval.payload : {};
}

function getRequestedActions(approval: BotApproval) {
  const payload = getApprovalPayload(approval);
  return isRecord(payload.requestedActions) ? payload.requestedActions : {};
}

function getApprovalQualification(approval: BotApproval) {
  const payload = getApprovalPayload(approval);
  return isRecord(payload.qualification) ? payload.qualification : null;
}

function getTextValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function getNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function knowledgeItemFromApi(source: NonNullable<KnowledgeApiResponse["sources"]>[number]): KnowledgeItem {
  const chunks = Math.max(1, Number(source.chunkCount ?? source.itemCount ?? source.embeddedChunkCount ?? 1));
  const embedded = Math.max(0, Number(source.embeddedChunkCount ?? 0));
  const normalizedStatus = source.status.trim().toLowerCase();
  const approved =
    embedded > 0 ||
    ["approved", "synced", "vector_ready", "vector bereit"].includes(normalizedStatus);

  return {
    id: source.id,
    workspaceId: "",
    projectId: source.projectId ?? "",
    name: source.title,
    items: chunks,
    coverage: `${Math.min(100, Math.round((embedded / chunks) * 100))}%`,
    status: approved ? "approved" : "needs-review",
  };
}

function getDocumentDeliveryError(documentSend: BotActionDocumentSend) {
  if (!isRecord(documentSend.metadata) || !isRecord(documentSend.metadata.delivery)) return null;

  return getTextValue(documentSend.metadata.delivery.error);
}

function isSendableDocumentAsset(asset: BotDocumentAsset) {
  return (
    asset.mimeType.startsWith("image/") ||
    asset.mimeType === "application/pdf" ||
    asset.mimeType === "application/msword" ||
    asset.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function hasPublicDocumentUrl(documentSend: BotActionDocumentSend) {
  return Boolean(documentSend.mediaAssetId && documentSend.mediaAssetPublicUrl);
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex >= 2 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatBotSetupSaveError(
  data: BotSetupMutationResponse,
  text: ReturnType<typeof getBotCommandCenterCopy>,
) {
  if (data.error?.startsWith("bot_publish_blocked")) {
    const labels = (data.blockers ?? []).map((blocker) => {
      const key = blocker as keyof typeof text.publishBlockerLabels;
      return text.publishBlockerLabels[key] ?? blocker;
    });

    return text.botPublishBlocked.replace("{{items}}", labels.join(", "));
  }

  return text.botSetupSaveError;
}

function isEvaluationRunReady(run: BotEvaluationRun | null | undefined) {
  return Boolean(
    run &&
      run.score >= 80 &&
      run.sourceCoverage >= 80 &&
      run.hallucinationFailures === 0 &&
      run.handoffFailures === 0 &&
      run.redTeamFailures === 0,
  );
}

function ConversationActionSummary({
  conversation,
  text,
}: {
  conversation: LiveBotConversation;
  text: ReturnType<typeof getBotCommandCenterCopy>;
}) {
  const summary = getBotRunSummary(conversation);

  if (!summary) return null;

  return (
    <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
      <div className="min-w-0 rounded-md bg-stone-50 p-3">
        <p className="break-words text-xs font-semibold uppercase leading-5 tracking-[0.08em] text-stone-500">{text.score}</p>
        <p className="mt-1 text-sm font-semibold text-slate-950">{summary.score ?? "-"}</p>
      </div>
      <div className="min-w-0 rounded-md bg-stone-50 p-3">
        <p className="break-words text-xs font-semibold uppercase leading-5 tracking-[0.08em] text-stone-500">{text.nextAction}</p>
        <p className="mt-1 break-words text-sm font-semibold text-slate-950">{summary.nextAction ?? "-"}</p>
      </div>
      <div className="min-w-0 rounded-md bg-stone-50 p-3">
        <p className="break-words text-xs font-semibold uppercase leading-5 tracking-[0.08em] text-stone-500">{text.requiresApproval}</p>
        <p className="mt-1">
          <Pill tone={summary.humanApprovalRequired || summary.humanHandoffRequired ? "rose" : "green"}>
            {summary.humanApprovalRequired || summary.humanHandoffRequired ? text.humanApproval : text.automatic}
          </Pill>
        </p>
      </div>
    </div>
  );
}

export function BotCommandCenter({
  automations,
  bots,
  callInsights,
  conversations,
  knowledgeItems,
  language,
  projectLabel,
  testPanel,
  tools,
  workflows,
}: BotCommandCenterProps) {
  const text = getBotCommandCenterCopy(language);
  const [activeTab, setActiveTab] = useState<BotTab>("overview");
  const [approvalActionResult, setApprovalActionResult] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<BotApproval[]>([]);
  const [approvalLoadStatus, setApprovalLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [approvalUpdatingId, setApprovalUpdatingId] = useState<string | null>(null);
  const [botActionResult, setBotActionResult] = useState<string | null>(null);
  const [botActionStatus, setBotActionStatus] = useState<"loading" | "ready" | "error">("loading");
  const [botActionUpdatingId, setBotActionUpdatingId] = useState<string | null>(null);
  const [botSetupSaveMessage, setBotSetupSaveMessage] = useState<string | null>(null);
  const [botSetupSaveStatus, setBotSetupSaveStatus] = useState<"idle" | "ready" | "error">("idle");
  const [botSetupSavingId, setBotSetupSavingId] = useState<string | null>(null);
  const [documentAssets, setDocumentAssets] = useState<BotDocumentAsset[]>([]);
  const [documentQuota, setDocumentQuota] = useState<BotDocumentsApiResponse["quota"] | null>(null);
  const [documentUploadErrors, setDocumentUploadErrors] = useState<Record<string, string>>({});
  const [documentUploadingId, setDocumentUploadingId] = useState<string | null>(null);
  const [documentSends, setDocumentSends] = useState<BotActionDocumentSend[]>([]);
  const [evaluationRuns, setEvaluationRuns] = useState<BotEvaluationRun[]>([]);
  const [evaluationStatus, setEvaluationStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [evaluationRunningId, setEvaluationRunningId] = useState<string | null>(null);
  const [evaluationResult, setEvaluationResult] = useState<string | null>(null);
  const [meetingBookings, setMeetingBookings] = useState<BotActionMeetingBooking[]>([]);
  const [liveConversations, setLiveConversations] = useState<LiveBotConversation[]>([]);
  const [liveWebhookEvents, setLiveWebhookEvents] = useState<ChannelApiResponse["recentWebhookEvents"]>([]);
  const [liveKnowledgeItems, setLiveKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [autonomyControls, setAutonomyControls] = useState<ChannelApiResponse["autonomyControls"] | null>(null);
  const [policyRules, setPolicyRules] = useState<NonNullable<ChannelApiResponse["policyRules"]>>([]);
  const [liveStatus, setLiveStatus] = useState<"loading" | "ready" | "error">("loading");
  const [showAdvancedTechnology, setShowAdvancedTechnology] = useState(false);
  const displayedKnowledgeItems = liveKnowledgeItems.length ? liveKnowledgeItems : knowledgeItems;
  const approvalTools = tools.filter((tool) => tool.requiresHumanApproval);
  const allChannels = bots.flatMap((bot) => bot.channels.map((channel) => ({ bot, channel })));
  const connectedChannels = allChannels.filter(({ channel }) => channel.active || channel.setupStatus === "connected");
  const setupItems = bots.flatMap((bot) => bot.setupChecklist ?? []);
  const doneSetupItems = setupItems.filter((item) => item.done);
  const approvedKnowledgeItems = displayedKnowledgeItems.filter((item) => item.status === "approved");
  const actionPolicies = bots.flatMap((bot) =>
    (bot.actionPolicies ?? []).map((policy) => ({
      ...policy,
      botName: bot.name,
    })),
  );
  const activeBotCount = bots.filter((bot) => bot.status === "active").length;
  const approvalCount =
    approvalTools.length +
    callInsights.filter((insight) => insight.requiresApproval).length +
    workflows.reduce((total, workflow) => total + workflow.approvalQueue, 0);
  const pendingApprovalCount = approvalLoadStatus === "ready" ? approvals.length : approvalCount;
  const openDocumentActionCount = documentSends.filter((item) => item.status !== "sent").length;
  const openMeetingActionCount = meetingBookings.filter((item) => item.status === "requested").length;
  const openBotActionCount = openDocumentActionCount + openMeetingActionCount;
  const incompleteSetupItem = setupItems.find((item) => !item.done);
  const knowledgeReady = approvedKnowledgeItems.length > 0 && bots.some((bot) => bot.strictKnowledge);
  const channelsReady = connectedChannels.length > 0;
  const handoffReady = bots.some((bot) => bot.channels.some((channel) => channel.handoffRules.length > 0));
  const testReady = bots.some((bot) => bot.status === "test" || bot.status === "active");
  const evaluationReady = bots.length > 0 && bots.every((bot) =>
    evaluationRuns.some((run) => run.botId === bot.id && isEvaluationRunReady(run)),
  );
  const readyToPublish = Boolean(channelsReady && knowledgeReady && handoffReady && testReady && evaluationReady && !pendingApprovalCount);
  const nextRecommendedStep = pendingApprovalCount
    ? text.nextStepReviewApprovals
    : incompleteSetupItem
      ? incompleteSetupItem.label
      : !channelsReady
        ? text.nextStepConnectChannels
        : !knowledgeReady
          ? text.nextStepApproveKnowledge
          : !handoffReady
            ? text.nextStepConfigureHandoff
            : !testReady
              ? text.nextStepTestBot
              : !evaluationReady
                ? text.nextStepRunBotEvaluation
                : text.nextStepReadyToPublish;
  const publishChecklist = [
    { done: channelsReady, label: text.publishChannelsReady },
    { done: knowledgeReady, label: text.publishKnowledgeReady },
    { done: handoffReady, label: text.publishHandoffReady },
    { done: testReady, label: text.publishTestReady },
    { done: evaluationReady, label: text.publishEvaluationReady },
    { done: pendingApprovalCount === 0, label: text.publishApprovalsReady },
  ];
  const demoConversations: LiveBotConversation[] = conversations.map((conversation) => ({
    botId: conversation.botId,
    contactId: conversation.contactId,
    id: conversation.id,
    latestMessage: conversation.messages.at(-1)
      ? {
          content: conversation.messages.at(-1)?.content ?? "",
          createdAt: conversation.messages.at(-1)?.createdAt ?? null,
          role: conversation.messages.at(-1)?.role ?? "user",
        }
      : null,
    projectId: conversation.projectId,
    source: "demo",
    status: conversation.status,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
  }));
  const displayConversations = activeBotCount > 0
    ? liveConversations.length ? liveConversations : demoConversations
    : [];
  const sendableDocumentAssets = documentAssets.filter(isSendableDocumentAsset);
  const openConversationCount = displayConversations.filter((conversation) => conversation.status !== "resolved").length;
  const endpointCards = [
    { id: "chat", method: text.methodPost, path: "/api/bots/chat" },
    { id: "agent", method: text.methodGetPost, path: "/api/bots/agent" },
    { id: "channels", method: text.methodGetPost, path: "/api/bots/channels" },
    { id: "channelWebhook", method: text.methodGetPost, path: "/api/bots/channels/webhook" },
    { id: "actions", method: text.methodGetPost, path: "/api/bots/actions" },
    { id: "leads", method: text.methodPost, path: "/api/bots/leads" },
    { id: "documents", method: text.methodGetPost, path: "/api/bots/documents" },
    { id: "meetings", method: text.methodGetPost, path: "/api/bots/meetings" },
    { id: "knowledge", method: text.methodPost, path: "/api/bots/knowledge" },
    { id: "evaluations", method: text.methodGetPost, path: "/api/bots/evaluations" },
    { id: "calls", method: text.methodPost, path: "/api/bots/calls" },
  ] as const;
  const tabs: Array<{ id: BotTab; label: string }> = [
    { id: "overview", label: text.tabLabels.overview },
    { id: "inbox", label: text.tabLabels.inbox },
    { id: "setup", label: text.tabLabels.setup },
    { id: "knowledge", label: text.tabLabels.knowledge },
    { id: "automations", label: text.tabLabels.automations },
    { id: "testPublish", label: text.tabLabels.testPublish },
  ];

  useEffect(() => {
    let cancelled = false;

    async function loadEvaluationRuns() {
      try {
        setEvaluationStatus("loading");
        const response = await fetch("/api/bots/evaluations?limit=20");

        if (!response.ok) {
          throw new Error("Bot evaluations unavailable");
        }

        const data = (await response.json()) as BotEvaluationsApiResponse;

        if (!cancelled) {
          setEvaluationRuns(data.runs ?? []);
          setEvaluationStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setEvaluationStatus("error");
        }
      }
    }

    if (activeTab === "testPublish") {
      void loadEvaluationRuns();
    }

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  async function runBotEvaluation(bot: CrmBot) {
    try {
      setEvaluationResult(null);
      setEvaluationRunningId(bot.id);
      const response = await fetch("/api/bots/evaluations", {
        body: JSON.stringify({ botId: bot.id, projectId: bot.projectId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Bot evaluation failed");
      }

      const data = (await response.json()) as { run?: BotEvaluationRun };

      if (!data.run) {
        throw new Error("Bot evaluation missing result");
      }

      setEvaluationRuns((current) => [data.run as BotEvaluationRun, ...current.filter((run) => run.id !== data.run?.id)]);
      setEvaluationStatus("ready");
      setEvaluationResult(text.evaluationRunSaved);
    } catch {
      setEvaluationStatus("error");
      setEvaluationResult(text.evaluationRunFailed);
    } finally {
      setEvaluationRunningId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadLiveBotState() {
      try {
        setLiveStatus("loading");
        setApprovalLoadStatus("loading");
        setBotActionStatus("loading");
        const [chatResponse, channelResponse, approvalResponse, actionResponse, documentResponse, knowledgeResponse] = await Promise.all([
          fetch("/api/bots/chat?limit=12"),
          fetch("/api/bots/channels"),
          fetch("/api/approvals?status=pending"),
          fetch("/api/bots/actions"),
          fetch("/api/bots/documents"),
          fetch("/api/bots/knowledge?limit=50"),
        ]);

        if (!chatResponse.ok || !channelResponse.ok || !approvalResponse.ok || !actionResponse.ok || !documentResponse.ok) {
          throw new Error("Bot live state unavailable");
        }

        const chatData = (await chatResponse.json()) as LiveChatApiResponse;
        const channelData = (await channelResponse.json()) as ChannelApiResponse;
        const approvalData = (await approvalResponse.json()) as ApprovalsApiResponse;
        const actionData = (await actionResponse.json()) as BotActionsApiResponse;
        const documentData = (await documentResponse.json()) as BotDocumentsApiResponse;
        const knowledgeData = knowledgeResponse.ok ? (await knowledgeResponse.json()) as KnowledgeApiResponse : null;

        if (cancelled) return;

        setLiveConversations(
          (chatData.conversations ?? []).map((conversation) => ({
            botId: conversation.botId,
            contactId: conversation.contactId,
            id: conversation.id,
            latestMessage: conversation.latestMessageContent
              ? {
                  content: conversation.latestMessageContent,
                  createdAt: conversation.latestMessageCreatedAt ?? null,
                  metadata: conversation.latestMessageMetadata,
                  role: conversation.latestMessageRole ?? "user",
                }
              : null,
            leadId: conversation.leadId,
            projectId: conversation.projectId,
            source: "live",
            status: conversation.status,
            title: conversation.title,
            updatedAt: conversation.updatedAt,
          })),
        );
        setLiveWebhookEvents(channelData.recentWebhookEvents ?? []);
        setAutonomyControls(channelData.autonomyControls ?? null);
        setPolicyRules(channelData.policyRules ?? []);
        setApprovals(approvalData.approvals ?? []);
        setDocumentAssets(documentData.assets ?? []);
        setDocumentQuota(documentData.quota ?? null);
        setDocumentSends(actionData.documentSends ?? []);
        setMeetingBookings(actionData.meetingBookings ?? []);
        if (knowledgeData?.sources?.length) {
          setLiveKnowledgeItems(knowledgeData.sources.map(knowledgeItemFromApi));
        }
        setApprovalLoadStatus("ready");
        setBotActionStatus("ready");
        setLiveStatus("ready");
      } catch {
        if (!cancelled) {
          setApprovalLoadStatus("error");
          setBotActionStatus("error");
          setLiveStatus("error");
        }
      }
    }

    void loadLiveBotState();

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  async function decideApproval(approvalId: string, decision: ApprovalDecision) {
    try {
      setApprovalUpdatingId(approvalId);
      const response = await fetch("/api/approvals", {
        body: JSON.stringify({ approvalId, decision }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Approval update failed");
      }

      const result = (await response.json()) as ApprovalDecisionResponse;
      const actionCount =
        (result.executedActions?.documentSendsCreated ?? 0) +
        (result.executedActions?.meetingBookingsCreated ?? 0) +
        (result.executedActions?.meetingProposalsPrepared ?? 0);

      setApprovals((current) => current.filter((approval) => approval.id !== approvalId));
      setApprovalActionResult(
        text.approvalDecisionSaved
          .replace("{{count}}", formatNumber(typeof result.updatedToolCalls === "number" ? result.updatedToolCalls : 0, language))
          .replace("{{actions}}", formatNumber(actionCount, language)),
      );
      const actionResponse = await fetch("/api/bots/actions");
      if (actionResponse.ok) {
        const actionData = (await actionResponse.json()) as BotActionsApiResponse;
        setDocumentSends(actionData.documentSends ?? []);
        setMeetingBookings(actionData.meetingBookings ?? []);
      }
      setApprovalLoadStatus("ready");
    } catch {
      setApprovalActionResult(null);
      setApprovalLoadStatus("error");
    } finally {
      setApprovalUpdatingId(null);
    }
  }

  async function saveBotSetup(bot: CrmBot) {
    try {
      setBotSetupSaveMessage(null);
      setBotSetupSaveStatus("idle");
      setBotSetupSavingId(bot.id);
      const response = await fetch("/api/crm/bots", {
        body: JSON.stringify({ bot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({})) as BotSetupMutationResponse;

      if (!response.ok) {
        throw new Error(formatBotSetupSaveError(data, text));
      }

      setBotSetupSaveStatus("ready");
    } catch (error) {
      setBotSetupSaveMessage(error instanceof Error && error.message ? error.message : text.botSetupSaveError);
      setBotSetupSaveStatus("error");
    } finally {
      setBotSetupSavingId(null);
    }
  }

  async function runBotAction(input: {
    action: "mark_sent" | "confirm" | "cancel";
    id: string;
    type: "document_send" | "meeting_booking";
  }) {
    try {
      setBotActionUpdatingId(input.id);
      setBotActionResult(null);
      const response = await fetch("/api/bots/actions", {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Bot action update failed");
      }

      const result = (await response.json()) as BotActionMutationResponse;

      if (result.documentSend) {
        setDocumentSends((current) =>
          current.map((item) => (item.id === result.documentSend?.id ? result.documentSend : item)),
        );
      }

      if (result.meetingBooking) {
        setMeetingBookings((current) =>
          current.map((item) => (item.id === result.meetingBooking?.id ? result.meetingBooking : item)),
        );
      }

      setBotActionResult(
        (text as { botActionSaved?: string }).botActionSaved ?? "Bot action updated.",
      );
      setBotActionStatus("ready");
    } catch {
      setBotActionResult(null);
      setBotActionStatus("error");
    } finally {
      setBotActionUpdatingId(null);
    }
  }

  async function attachDocumentAsset(documentSendId: string, mediaAssetId: string) {
    try {
      setBotActionUpdatingId(documentSendId);
      setBotActionResult(null);
      setDocumentUploadErrors((current) => {
        const next = { ...current };
        delete next[documentSendId];
        return next;
      });

      const response = await fetch("/api/bots/actions", {
        body: JSON.stringify({
          action: "attach_media_asset",
          id: documentSendId,
          mediaAssetId,
          type: "document_send",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Document could not be attached.");
      }

      const result = (await response.json()) as BotActionMutationResponse;

      if (result.documentSend) {
        setDocumentSends((current) =>
          current.map((item) => (item.id === result.documentSend?.id ? result.documentSend : item)),
        );
      }

      setBotActionResult((text as { botActionSaved?: string }).botActionSaved ?? "Bot action updated.");
      setBotActionStatus("ready");
      return true;
    } catch (error) {
      setDocumentUploadErrors((current) => ({
        ...current,
        [documentSendId]: error instanceof Error ? error.message : text.actionOutboxLoadError,
      }));
      return false;
    } finally {
      setBotActionUpdatingId(null);
    }
  }

  async function uploadDocumentForAction(documentSend: BotActionDocumentSend, file: File) {
    const maxFileBytes = documentQuota?.maxFileBytes ?? 10 * 1024 * 1024;

    if (file.size > maxFileBytes) {
      setDocumentUploadErrors((current) => ({
        ...current,
        [documentSend.id]: text.documentFileTooLarge.replace("{{size}}", formatFileSize(maxFileBytes)),
      }));
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("folder", "bot-documents");
    formData.append("name", file.name);
    formData.append("alt", file.name.replace(/\.[^.]+$/, ""));

    try {
      setDocumentUploadingId(documentSend.id);
      setDocumentUploadErrors((current) => {
        const next = { ...current };
        delete next[documentSend.id];
        return next;
      });

      const response = await fetch("/api/media", {
        body: formData,
        method: "POST",
      });
      const payload = (await response.json()) as {
        asset?: BotDocumentAsset;
        error?: string;
        quota?: BotDocumentsApiResponse["quota"];
      };

      if (!response.ok || !payload.asset) {
        throw new Error(payload.error || text.documentUploadFailed);
      }

      setDocumentAssets((current) => [payload.asset as BotDocumentAsset, ...current.filter((asset) => asset.id !== payload.asset?.id)]);
      if (payload.quota) setDocumentQuota(payload.quota);
      await attachDocumentAsset(documentSend.id, payload.asset.id);
    } catch (error) {
      setDocumentUploadErrors((current) => ({
        ...current,
        [documentSend.id]: error instanceof Error ? error.message : text.documentUploadFailed,
      }));
    } finally {
      setDocumentUploadingId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {text.commandCenterEyebrow}
            </p>
            <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">{text.cleanTitle}</h3>
            <p className="mt-2 max-w-4xl break-words text-sm text-stone-600">{text.cleanDescription}</p>
          </div>
          <span className="rounded-md bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-700">
            {text.scope}: {projectLabel}
          </span>
        </div>

        <div className="mt-5 overflow-x-auto">
          <div className="flex min-w-max gap-2 rounded-lg bg-stone-100 p-1">
            {tabs.map((tab) => (
              <button
                className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
                  activeTab === tab.id
                    ? "bg-white text-slate-950 shadow-sm"
                    : "text-stone-600 hover:bg-white/70 hover:text-slate-900"
                }`}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm font-semibold text-emerald-950">{text.guardrailTitle}</p>
          <p className="mt-1 text-sm leading-6 text-emerald-900">{text.guardrailDescription}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {text.guardrailItems.map((item) => (
              <span className="rounded-md border border-emerald-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-emerald-950" key={item}>
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>

      {activeTab === "overview" ? (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {[
              [text.activeBots, activeBotCount],
              [text.connectedChannels, connectedChannels.length],
              [text.approvals, pendingApprovalCount],
              [text.openConversations, openConversationCount],
              [text.setupProgress, `${doneSetupItems.length}/${Math.max(setupItems.length, 1)}`],
              [text.publishReadiness, readyToPublish ? text.readyToPublish : text.notReadyToPublish],
            ].map(([label, value]) => (
              <div className="rounded-lg border border-stone-200 bg-white p-4" key={label}>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">{label}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {typeof value === "number" ? formatNumber(value, language) : value}
                </p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
            <section className="rounded-lg border border-stone-200 bg-white p-5">
              <h3 className="text-lg font-semibold text-slate-950">{text.setupChecklist}</h3>
              <p className="mt-1 text-sm text-stone-600">{text.setupChecklistDescription}</p>
              <div className="mt-4 space-y-2">
                {setupItems.length ? (
                  setupItems.map((item) => (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-stone-50 p-3" key={item.label}>
                      <span className="min-w-0 break-words text-sm font-semibold text-slate-900">{item.label}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <Pill>{text.owner}: {item.owner}</Pill>
                        <Pill tone={item.done ? "green" : "slate"}>{item.done ? text.enabled : text.disabled}</Pill>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noBots}</p>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-950">{text.nextOperationalSteps}</h3>
                  <p className="mt-1 text-sm text-stone-600">{text.nextRecommendedStep}</p>
                </div>
                <Pill tone={readyToPublish ? "green" : "amber"}>{nextRecommendedStep}</Pill>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {bots.map((bot) => (
                  <article className="rounded-lg border border-stone-200 p-4" key={bot.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-slate-950">{bot.name}</p>
                        <p className="mt-1 break-words text-sm text-stone-600">{bot.audience}</p>
                      </div>
                      <StatusPill label={text.statusLabels[bot.status]} status={bot.status} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {bot.channels.map((channel) => (
                        <Pill key={channel.id} tone={channel.active ? "green" : "slate"}>{channel.channel}</Pill>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <section className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{text.liveInboxTitle}</h3>
                <p className="mt-1 text-sm text-stone-600">{text.liveInboxDescription}</p>
              </div>
              <Pill tone={liveStatus === "ready" && liveConversations.length ? "green" : "slate"}>
                {liveStatus === "loading"
                  ? text.loadingLiveData
                  : liveConversations.length
                    ? text.liveData
                    : text.demoData}
              </Pill>
            </div>
            <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {displayConversations.slice(0, 3).map((conversation) => (
                <article className="min-w-0 rounded-lg border border-stone-200 p-4" key={conversation.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words text-sm font-semibold text-slate-950">{conversation.title}</p>
                    <StatusPill
                      label={text.statusLabels[conversation.status as keyof typeof text.statusLabels] ?? conversation.status}
                      status={conversation.status}
                    />
                  </div>
                  <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.answer}</p>
                  <p className="mt-1 line-clamp-2 break-words text-sm text-stone-600">
                    {conversation.latestMessage?.content ?? text.noConversationPreview}
                  </p>
                  <ConversationActionSummary conversation={conversation} text={text} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Pill tone={conversation.source === "live" ? "green" : "slate"}>
                      {conversation.source === "live" ? text.liveData : text.demoData}
                    </Pill>
                    <Pill>{new Date(conversation.updatedAt).toLocaleString(language === "de" ? "de-AT" : "en-US")}</Pill>
                  </div>
                </article>
              ))}
              {!displayConversations.length ? (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noConversations}</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "inbox" ? (
        <section className="grid gap-4 xl:grid-cols-[1fr_0.8fr]">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{text.inboxTabTitle}</h3>
                <p className="mt-1 text-sm text-stone-600">{text.inboxTabDescription}</p>
              </div>
              <Pill tone={liveStatus === "ready" && liveConversations.length ? "green" : "slate"}>
                {liveStatus === "error" ? text.liveDataUnavailable : liveConversations.length ? text.liveData : text.demoData}
              </Pill>
            </div>
            <div className="mt-4 space-y-3">
              {displayConversations.length ? (
                displayConversations.map((conversation) => (
                  <article className="rounded-lg border border-stone-200 p-4" key={conversation.id}>
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="break-words text-base font-semibold text-slate-950">{conversation.title}</h4>
                          <StatusPill
                            label={text.statusLabels[conversation.status as keyof typeof text.statusLabels] ?? conversation.status}
                            status={conversation.status}
                          />
                        </div>
                        <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.answer}</p>
                        <p className="mt-1 break-words text-sm text-stone-600">
                          {conversation.latestMessage?.content ?? text.noConversationPreview}
                        </p>
                        <ConversationActionSummary conversation={conversation} text={text} />
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Pill tone={conversation.source === "live" ? "green" : "slate"}>
                          {conversation.source === "live" ? text.liveData : text.demoData}
                        </Pill>
                        <Pill>{new Date(conversation.updatedAt).toLocaleString(language === "de" ? "de-AT" : "en-US")}</Pill>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noConversations}</p>
              )}
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h3 className="text-lg font-semibold text-slate-950">{text.webhookInboxTitle}</h3>
            <p className="mt-1 text-sm text-stone-600">{text.webhookInboxDescription}</p>
            <div className="mt-4 space-y-3">
              {liveWebhookEvents?.length ? (
                liveWebhookEvents.map((event) => (
                  <div className="rounded-lg border border-stone-200 p-4" key={event.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{event.channel}</p>
                        <p className="mt-1 text-xs text-stone-500">{event.contactRef ?? text.unknownContact}</p>
                      </div>
                      <Pill tone={event.status === "routed" ? "green" : "slate"}>{event.status}</Pill>
                    </div>
                    <p className="mt-3 break-words text-sm text-stone-600">
                      {event.normalizedMessage?.text ?? text.noConversationPreview}
                    </p>
                  </div>
                ))
              ) : (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noWebhookEvents}</p>
              )}
            </div>
          </article>
        </section>
      ) : null}

      {activeTab === "automations" ? (
        <section className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-950">{text.approvalCenterTitle}</h3>
              <p className="mt-1 max-w-3xl text-sm text-stone-600">{text.approvalCenterDescription}</p>
            </div>
            <Pill tone={pendingApprovalCount ? "amber" : "green"}>
              {formatNumber(pendingApprovalCount, language)} {text.pendingApprovals}
            </Pill>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-4">
            {[
              {
                label: text.autonomousMode,
                tone: autonomyControls?.killSwitch || autonomyControls?.requireHumanApproval ? "amber" as const : "green" as const,
                value: autonomyControls?.killSwitch || autonomyControls?.requireHumanApproval ? text.disabled : text.enabled,
              },
              {
                label: text.testModeControl,
                tone: autonomyControls?.testMode ? "blue" as const : "slate" as const,
                value: autonomyControls?.testMode ? text.enabled : text.disabled,
              },
              {
                label: text.killSwitch,
                tone: autonomyControls?.killSwitch ? "rose" as const : "green" as const,
                value: autonomyControls?.killSwitch ? text.enabled : text.disabled,
              },
              {
                label: text.strictKnowledge,
                tone: autonomyControls?.strictKnowledge === false ? "amber" as const : "green" as const,
                value: autonomyControls?.strictKnowledge === false ? text.disabled : text.enabled,
              },
            ].map((item) => (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={item.label}>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">{item.label}</p>
                <p className="mt-2">
                  <Pill tone={item.tone}>{item.value}</Pill>
                </p>
              </div>
            ))}
          </div>

          {autonomyControls?.disabledReason ? (
            <p className="mt-4 rounded-md bg-rose-50 p-3 text-sm font-semibold text-rose-800">
              {autonomyControls.disabledReason}
            </p>
          ) : null}

          <div className="mt-5 rounded-lg border border-stone-200 p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.policyRulesTitle}</h4>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {policyRules.map((rule) => (
                <div className="flex items-start justify-between gap-3 rounded-md bg-stone-50 p-3" key={rule.id}>
                  <p className="min-w-0 break-words text-sm font-semibold text-slate-900">{rule.label}</p>
                  <Pill tone={rule.effect === "block" ? "rose" : rule.effect === "test" ? "blue" : "green"}>
                    {text.policyEffectLabels[rule.effect]}
                  </Pill>
                </div>
              ))}
            </div>
          </div>

          {approvalLoadStatus === "error" ? (
            <p className="mt-4 rounded-md bg-rose-50 p-3 text-sm font-semibold text-rose-800">
              {text.approvalLoadError}
            </p>
          ) : null}
          {approvalActionResult ? (
            <p className="mt-4 rounded-md bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
              {approvalActionResult}
            </p>
          ) : null}

          <div className="mt-5 space-y-3">
            {approvalLoadStatus === "loading" ? (
              <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.loadingApprovals}</p>
            ) : null}

            {approvalLoadStatus !== "loading" && approvals.length ? (
              approvals.map((approval) => {
                const payload = getApprovalPayload(approval);
                const requestedActions = getRequestedActions(approval);
                const qualification = getApprovalQualification(approval);
                const score = getNumberValue(qualification?.score);
                const stage = getTextValue(qualification?.stage);
                const prompt = getTextValue(payload.prompt);
                const botName = getTextValue(payload.botName);
                const channel = getTextValue(payload.channel);
                const documentRequested = requestedActions.document === true;
                const meetingRequested = requestedActions.meeting === true;
                const toolCallCount = Array.isArray(payload.toolCallIds) ? payload.toolCallIds.length : 0;
                const isUpdating = approvalUpdatingId === approval.id;

                return (
                  <article className="rounded-lg border border-stone-200 p-4" key={approval.id}>
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="break-words text-base font-semibold text-slate-950">{approval.summary}</h4>
                          <StatusPill
                            label={text.approvalStatusLabels[approval.status as keyof typeof text.approvalStatusLabels] ?? approval.status}
                            status={approval.status}
                          />
                        </div>
                        <p className="mt-2 break-words text-sm text-stone-600">
                          {botName ? `${botName} · ` : ""}
                          {channel ? `${channel} · ` : ""}
                          {approval.action}
                        </p>
                        {prompt ? (
                          <div className="mt-3 rounded-md bg-stone-50 p-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                              {text.customerMessage}
                            </p>
                            <p className="mt-1 break-words text-sm text-slate-900">{prompt}</p>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Pill>{new Date(approval.createdAt).toLocaleString(language === "de" ? "de-AT" : "en-US")}</Pill>
                        <Pill>{approval.entityType}</Pill>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-4">
                      <div className="rounded-md bg-stone-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.score}</p>
                        <p className="mt-1 text-sm font-semibold text-slate-950">{score ?? "-"}</p>
                      </div>
                      <div className="rounded-md bg-stone-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.stage}</p>
                        <p className="mt-1 break-words text-sm font-semibold text-slate-950">{stage ?? "-"}</p>
                      </div>
                      <div className="rounded-md bg-stone-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.requestedActions}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {documentRequested ? <Pill tone="rose">{text.documentRequested}</Pill> : null}
                          {meetingRequested ? <Pill tone="amber">{text.meetingRequested}</Pill> : null}
                          {!documentRequested && !meetingRequested ? <Pill>{text.noWriteAction}</Pill> : null}
                        </div>
                      </div>
                      <div className="rounded-md bg-stone-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.toolRuns}</p>
                        <p className="mt-1 text-sm font-semibold text-slate-950">{toolCallCount}</p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                      <button
                        className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isUpdating}
                        onClick={() => void decideApproval(approval.id, "handoff")}
                        type="button"
                      >
                        {text.handoffToHuman}
                      </button>
                      <button
                        className="rounded-md border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isUpdating}
                        onClick={() => void decideApproval(approval.id, "denied")}
                        type="button"
                      >
                        {text.denyApproval}
                      </button>
                      <button
                        className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isUpdating}
                        onClick={() => void decideApproval(approval.id, "approved")}
                        type="button"
                      >
                        {isUpdating ? text.savingApproval : text.approveApproval}
                      </button>
                    </div>
                  </article>
                );
              })
            ) : null}

            {approvalLoadStatus !== "loading" && !approvals.length ? (
              <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noPendingApprovals}</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {activeTab === "setup" ? (
        <section className="rounded-lg border border-stone-200 bg-white p-5">
          <h3 className="text-lg font-semibold text-slate-950">{text.setupTabTitle}</h3>
          <p className="mt-1 text-sm text-stone-600">{text.setupTabDescription}</p>
          {botSetupSaveStatus === "ready" ? (
            <p className="mt-4 rounded-md bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
              {text.botSetupSaved}
            </p>
          ) : null}
          {botSetupSaveStatus === "error" ? (
            <p className="mt-4 rounded-md bg-rose-50 p-3 text-sm font-semibold text-rose-800">
              {botSetupSaveMessage ?? text.botSetupSaveError}
            </p>
          ) : null}
          <h4 className="mt-5 text-base font-semibold text-slate-950">{text.botListTitle}</h4>
          <p className="mt-1 text-sm text-stone-600">{text.botListDescription}</p>
          <div className="mt-4 grid gap-3">
            {bots.length ? (
              bots.map((bot) => (
                <article className="rounded-lg border border-stone-200 p-4" key={bot.id}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="break-words text-base font-semibold text-slate-950">{bot.name}</h4>
                        <StatusPill label={text.statusLabels[bot.status]} status={bot.status} />
                      </div>
                      <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">{bot.description}</p>
                    </div>
                    <div className="grid shrink-0 gap-3">
                      <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-md bg-stone-50 px-3 py-2">
                          <p className="font-semibold text-slate-950">{bot.channels.length}</p>
                          <p className="text-stone-500">{text.channels}</p>
                        </div>
                        <div className="rounded-md bg-stone-50 px-3 py-2">
                          <p className="font-semibold text-slate-950">{bot.tools.length}</p>
                          <p className="text-stone-500">{text.tools}</p>
                        </div>
                        <div className="rounded-md bg-stone-50 px-3 py-2">
                          <p className="font-semibold text-slate-950">{bot.strictKnowledge ? text.enabled : text.disabled}</p>
                          <p className="text-stone-500">{text.strictKnowledge}</p>
                        </div>
                      </div>
                      <button
                        className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={botSetupSavingId === bot.id}
                        onClick={() => void saveBotSetup(bot)}
                        type="button"
                      >
                        {botSetupSavingId === bot.id ? text.savingBotSetup : text.saveBotSetup}
                      </button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noBots}</p>
            )}
          </div>
        </section>
      ) : null}

      {activeTab === "setup" ? (
        <section className="rounded-lg border border-stone-200 bg-white p-5">
          <h3 className="text-lg font-semibold text-slate-950">{text.channelSetup}</h3>
          <p className="mt-1 text-sm text-stone-600">{text.channelsDescription}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {allChannels.map(({ bot, channel }) => (
              <article className="rounded-lg border border-stone-200 p-4" key={`${bot.id}-${channel.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-slate-950">{channel.channel}</p>
                    <p className="mt-1 break-words text-xs text-stone-500">{bot.name}</p>
                  </div>
                  <StatusPill
                    label={channel.setupStatus ? text.setupStatusLabels[channel.setupStatus] : channel.active ? text.enabled : text.disabled}
                    status={channel.setupStatus ?? (channel.active ? "connected" : "not_connected")}
                  />
                </div>
                <dl className="mt-4 grid gap-2 text-sm">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.provider}</dt>
                    <dd className="mt-1 break-words text-slate-900">{channel.provider ?? channel.channel}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Webhook</dt>
                    <dd className="mt-1 break-words font-mono text-xs text-slate-700">{channel.webhookPath ?? "/api/bots/chat"}</dd>
                  </div>
                </dl>
                <div className="mt-4 rounded-md bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.customerSetupFlow}
                  </p>
                  <div className="mt-3 grid gap-2">
                    {(channel.setupSteps?.length ? channel.setupSteps : [text.connectStep, text.verifyStep, text.testStep]).map(
                      (step, index) => (
                        <div className="flex items-center gap-2 text-sm" key={step}>
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-900">
                            {index + 1}
                          </span>
                          <span className="min-w-0 break-words text-stone-700">{step}</span>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === "knowledge" ? (
        <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{text.knowledgeTabTitle}</h3>
                <p className="mt-1 max-w-3xl text-sm text-stone-600">{text.knowledgeTabDescription}</p>
              </div>
              <a className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800" href="#knowledge">
                {text.manageKnowledge}
              </a>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-stone-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">{text.knowledgeSources}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{displayedKnowledgeItems.length}</p>
              </div>
              <div className="rounded-lg bg-stone-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">{text.approvedKnowledge}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{approvedKnowledgeItems.length}</p>
              </div>
              <div className="rounded-lg bg-stone-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">{text.strictKnowledge}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {bots.filter((bot) => bot.strictKnowledge).length}/{Math.max(bots.length, 1)}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {displayedKnowledgeItems.length ? (
                displayedKnowledgeItems.map((item) => (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-stone-200 p-3" key={item.id}>
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-slate-950">{item.name}</p>
                      <p className="mt-1 text-xs text-stone-500">
                        {item.items} {text.chunks} · {item.coverage}
                      </p>
                    </div>
                    <Pill tone={item.status === "approved" ? "green" : "amber"}>{item.status}</Pill>
                  </div>
                ))
              ) : (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noKnowledgeSources}</p>
              )}
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h3 className="text-lg font-semibold text-slate-950">{text.documentLibrary}</h3>
            <p className="mt-1 text-sm text-stone-600">{text.documentLibraryDescription}</p>
            <div className="mt-4 grid gap-3">
              {bots.map((bot) => (
                <div className="rounded-lg border border-stone-200 p-4" key={bot.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="break-words text-sm font-semibold text-slate-950">{bot.name}</p>
                    <Pill tone={bot.strictKnowledge ? "green" : "amber"}>
                      {bot.strictKnowledge ? text.strictKnowledge : text.disabled}
                    </Pill>
                  </div>
                  <div className="mt-3 space-y-2">
                    {(bot.documentLibrary ?? []).map((document) => (
                      <div className="flex items-center justify-between gap-3 rounded-md bg-stone-50 p-3 text-sm" key={document.id}>
                        <span className="break-words font-semibold text-slate-900">{document.name}</span>
                        <Pill tone={document.status === "approved" ? "green" : "amber"}>{document.status}</Pill>
                      </div>
                    ))}
                    {!(bot.documentLibrary ?? []).length ? (
                      <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noDocuments}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>
      ) : null}

      {activeTab === "automations" ? (
        <section className="space-y-4">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{text.actionOutboxTitle}</h3>
                <p className="mt-1 max-w-3xl text-sm text-stone-600">{text.actionOutboxDescription}</p>
              </div>
              <Pill tone={openBotActionCount ? "amber" : "green"}>
                {formatNumber(openBotActionCount, language)} {text.openActions}
              </Pill>
            </div>

            {botActionStatus === "error" ? (
              <p className="mt-4 rounded-md bg-rose-50 p-3 text-sm font-semibold text-rose-800">
                {text.actionOutboxLoadError}
              </p>
            ) : null}
            {botActionResult ? (
              <p className="mt-4 rounded-md bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                {botActionResult}
              </p>
            ) : null}

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-stone-200 p-4">
                <h4 className="text-base font-semibold text-slate-950">{text.documentOutbox}</h4>
                <div className="mt-3 space-y-3">
                  {botActionStatus === "loading" ? (
                    <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.loadingLiveData}</p>
                  ) : null}
                  {botActionStatus !== "loading" && documentSends.length ? (
                    documentSends.map((documentSend) => {
                      const isUpdating = botActionUpdatingId === documentSend.id;
                      const isUploading = documentUploadingId === documentSend.id;
                      const canSendDocument = hasPublicDocumentUrl(documentSend);
                      const deliveryError = getDocumentDeliveryError(documentSend);
                      const uploadError = documentUploadErrors[documentSend.id];

                      return (
                        <div className="rounded-md bg-stone-50 p-3" key={documentSend.id}>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="break-words text-sm font-semibold text-slate-950">
                                {documentSend.mediaAssetName ?? documentSend.documentName}
                              </p>
                              <p className="mt-1 break-words text-xs text-stone-500">
                                {documentSend.channel} - {documentSend.conversationTitle ?? text.noConversationPreview}
                              </p>
                              {documentSend.mediaAssetName && documentSend.mediaAssetPublicUrl ? (
                                <p className="mt-2 break-words text-xs font-semibold text-emerald-800">
                                  {text.attachedDocument}: {documentSend.mediaAssetName}
                                </p>
                              ) : null}
                            </div>
                            <StatusPill
                              label={text.botActionStatusLabels[documentSend.status as keyof typeof text.botActionStatusLabels] ?? documentSend.status}
                              status={documentSend.status}
                            />
                          </div>
                          {deliveryError ? (
                            <p className="mt-3 rounded-md bg-rose-50 p-3 text-xs font-semibold text-rose-800">
                              {deliveryError}
                            </p>
                          ) : null}
                          {!canSendDocument && documentSend.status !== "sent" ? (
                            <div className="mt-3 grid gap-2 rounded-md border border-dashed border-stone-300 bg-white p-3">
                              <p className="text-xs font-semibold text-stone-700">{text.documentRequiredHint}</p>
                              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                                <select
                                  className="min-w-0 rounded-md border border-stone-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950"
                                  onChange={(event) => {
                                    if (event.target.value) void attachDocumentAsset(documentSend.id, event.target.value);
                                  }}
                                  value={documentSend.mediaAssetId ?? ""}
                                >
                                  <option value="">{text.selectDocumentPlaceholder}</option>
                                  {sendableDocumentAssets.map((asset) => (
                                    <option key={asset.id} value={asset.id}>
                                      {asset.name} ({formatFileSize(asset.sizeBytes)})
                                    </option>
                                  ))}
                                </select>
                                <label className="cursor-pointer rounded-md bg-white px-3 py-2 text-center text-sm font-semibold text-slate-950 ring-1 ring-stone-200 hover:bg-stone-50">
                                  {isUploading ? text.uploadingDocument : text.uploadDocument}
                                  <input
                                    accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                                    className="sr-only"
                                    disabled={isUploading || isUpdating}
                                    onChange={(event) => {
                                      const file = event.target.files?.[0];
                                      if (file) void uploadDocumentForAction(documentSend, file);
                                      event.currentTarget.value = "";
                                    }}
                                    type="file"
                                  />
                                </label>
                              </div>
                              {!sendableDocumentAssets.length ? (
                                <p className="text-xs text-stone-500">{text.noDocumentAssets}</p>
                              ) : null}
                            </div>
                          ) : null}
                          {uploadError ? (
                            <p className="mt-3 rounded-md bg-rose-50 p-3 text-xs font-semibold text-rose-800">
                              {uploadError}
                            </p>
                          ) : null}
                          {documentSend.status !== "sent" ? (
                            <button
                              className="mt-3 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={isUpdating || isUploading || !canSendDocument}
                              onClick={() => void runBotAction({ action: "mark_sent", id: documentSend.id, type: "document_send" })}
                              type="button"
                            >
                              {text.markDocumentSent}
                            </button>
                          ) : null}
                        </div>
                      );
                    })
                  ) : null}
                  {botActionStatus !== "loading" && !documentSends.length ? (
                    <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noDocumentActions}</p>
                  ) : null}
                </div>
              </div>

              <div className="rounded-lg border border-stone-200 p-4">
                <h4 className="text-base font-semibold text-slate-950">{text.meetingOutbox}</h4>
                <div className="mt-3 space-y-3">
                  {botActionStatus === "loading" ? (
                    <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.loadingLiveData}</p>
                  ) : null}
                  {botActionStatus !== "loading" && meetingBookings.length ? (
                    meetingBookings.map((meetingBooking) => {
                      const isUpdating = botActionUpdatingId === meetingBooking.id;

                      return (
                        <div className="rounded-md bg-stone-50 p-3" key={meetingBooking.id}>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="break-words text-sm font-semibold text-slate-950">
                                {meetingBooking.contactName || text.unknownContact}
                              </p>
                              <p className="mt-1 break-words text-xs text-stone-500">
                                {new Date(meetingBooking.startsAt).toLocaleString(language === "de" ? "de-AT" : "en-US")} - {meetingBooking.slug}
                              </p>
                            </div>
                            <StatusPill
                              label={text.botActionStatusLabels[meetingBooking.status as keyof typeof text.botActionStatusLabels] ?? meetingBooking.status}
                              status={meetingBooking.status}
                            />
                          </div>
                          {meetingBooking.status === "requested" ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isUpdating}
                                onClick={() => void runBotAction({ action: "confirm", id: meetingBooking.id, type: "meeting_booking" })}
                                type="button"
                              >
                                {text.confirmMeetingAction}
                              </button>
                              <button
                                className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isUpdating}
                                onClick={() => void runBotAction({ action: "cancel", id: meetingBooking.id, type: "meeting_booking" })}
                                type="button"
                              >
                                {text.cancelMeetingAction}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  ) : null}
                  {botActionStatus !== "loading" && !meetingBookings.length ? (
                    <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noMeetingActions}</p>
                  ) : null}
                </div>
              </div>
            </div>
          </article>

          <div className="grid gap-4 xl:grid-cols-3">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h3 className="text-lg font-semibold text-slate-950">{text.actionsTabTitle}</h3>
            <p className="mt-1 text-sm text-stone-600">{text.actionsTabDescription}</p>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.12em] text-stone-500">
                  <tr>
                    <th className="border-b border-stone-200 px-3 py-2">{text.action}</th>
                    <th className="border-b border-stone-200 px-3 py-2">{text.requiresApproval}</th>
                    <th className="border-b border-stone-200 px-3 py-2">{text.botCore}</th>
                  </tr>
                </thead>
                <tbody>
                  {actionPolicies.map((policy) => (
                    <tr key={`${policy.botName}-${policy.action}`}>
                      <td className="border-b border-stone-100 px-3 py-3 font-semibold text-slate-950">{policy.action}</td>
                      <td className="border-b border-stone-100 px-3 py-3">
                        <Pill tone={policy.approval === "required" ? "rose" : "green"}>{text.approvalModeLabels[policy.approval]}</Pill>
                      </td>
                      <td className="border-b border-stone-100 px-3 py-3 text-stone-600">{policy.botName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h3 className="text-lg font-semibold text-slate-950">{text.leadAutomation}</h3>
            <div className="mt-4 space-y-3">
              {workflows.length ? (
              workflows.map((workflow) => (
                <div className="rounded-lg border border-stone-200 p-4" key={workflow.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">{workflow.name}</p>
                      <p className="mt-1 text-xs text-stone-500">{text.triggerLabels[workflow.trigger]}</p>
                    </div>
                    <Pill tone={workflow.active ? "green" : "slate"}>{workflow.active ? text.enabled : text.disabled}</Pill>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {workflow.steps.map((step) => (
                      <Pill key={step}>{text.workflowStepLabels[step]}</Pill>
                    ))}
                  </div>
                </div>
              ))
              ) : (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noWorkflows}</p>
              )}
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h3 className="text-lg font-semibold text-slate-950">{text.crmAutomationsTitle}</h3>
            <p className="mt-1 text-sm text-stone-600">{text.crmAutomationsDescription}</p>
            <div className="mt-4 space-y-3">
              {automations.length ? (
                automations.map((automation) => (
                  <div className="rounded-lg border border-stone-200 p-4" key={automation.id}>
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-slate-950">{automation.name}</p>
                        <p className="mt-1 break-words text-xs text-stone-500">{automation.channel}</p>
                      </div>
                      <StatusPill
                        label={text.automationStatusLabels[automation.status]}
                        status={automation.status}
                      />
                    </div>
                    <p className="mt-3 break-words text-sm text-stone-600">{automation.detail}</p>
                  </div>
                ))
              ) : (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noCrmAutomations}</p>
              )}
            </div>
          </article>
          </div>
        </section>
      ) : null}

      {activeTab === "testPublish" ? (
        <section className="space-y-4">
          <div className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{text.testPublishTitle}</h3>
                <p className="mt-1 text-sm text-stone-600">{text.testPublishDescription}</p>
              </div>
              <Pill tone={readyToPublish ? "green" : "amber"}>{readyToPublish ? text.readyToPublish : text.notReadyToPublish}</Pill>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              {publishChecklist.map((item) => (
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={item.label}>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">{item.label}</p>
                  <p className="mt-2">
                    <Pill tone={item.done ? "green" : "amber"}>{item.done ? text.enabled : text.disabled}</Pill>
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-4 rounded-md bg-stone-50 p-3 text-sm font-semibold text-slate-700">
              {text.publishServerEnforced}
            </p>
          </div>
          {testPanel}
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{text.evaluationTitle}</h3>
                <p className="mt-1 text-sm text-stone-600">{text.evaluationDescription}</p>
              </div>
              <Pill tone={evaluationStatus === "error" ? "rose" : evaluationReady ? "green" : "amber"}>
                {evaluationStatus === "loading" ? text.loadingLiveData : evaluationReady ? text.readyToPublish : text.notReadyToPublish}
              </Pill>
            </div>
            {evaluationResult ? (
              <p className="mt-3 rounded-md bg-stone-50 p-3 text-sm font-medium text-slate-700">{evaluationResult}</p>
            ) : null}
            <div className="mt-5 space-y-3">
              {bots.length ? (
                bots.map((bot) => {
                  const latestRun = evaluationRuns.find((run) => run.botId === bot.id);
                  const passed = isEvaluationRunReady(latestRun);
                  const failedCases = latestRun?.cases.filter((evaluationCase) => !evaluationCase.passed) ?? [];
                  const citationCases = latestRun?.cases.filter((evaluationCase) => evaluationCase.citationsRequired) ?? [];
                  const coveredCitationCases = citationCases.filter(
                    (evaluationCase) => evaluationCase.sourceCount > 0 && evaluationCase.citationCount > 0,
                  );
                  const redTeamCases =
                    latestRun?.cases.filter(
                      (evaluationCase) =>
                        evaluationCase.kind === "prompt_injection" || evaluationCase.kind === "risky",
                    ) ?? [];
                  const passedRedTeamCases = redTeamCases.filter((evaluationCase) => evaluationCase.passed);

                  return (
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={bot.id}>
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="font-semibold text-slate-950">{bot.name}</p>
                          <p className="mt-1 text-xs text-stone-500">
                            {latestRun
                              ? `${text.latestEvaluation}: ${new Date(latestRun.createdAt).toLocaleString(language === "de" ? "de-AT" : "en-US")}`
                              : text.noEvaluationRuns}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill tone={passed ? "green" : "amber"}>{passed ? text.readyToPublish : text.notReadyToPublish}</Pill>
                          <button
                            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={evaluationRunningId === bot.id}
                            onClick={() => void runBotEvaluation(bot)}
                            type="button"
                          >
                            {evaluationRunningId === bot.id ? text.runningEvaluation : text.runEvaluation}
                          </button>
                        </div>
                      </div>
                      {latestRun ? (
                        <>
                          <div className="mt-4 grid gap-3 md:grid-cols-4">
                            <div className="rounded-md bg-white p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">{text.evaluationScore}</p>
                              <p className="mt-1 text-lg font-semibold text-slate-950">{latestRun.score}%</p>
                            </div>
                            <div className="rounded-md bg-white p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">{text.sourceCoverage}</p>
                              <p className="mt-1 text-lg font-semibold text-slate-950">{latestRun.sourceCoverage}%</p>
                            </div>
                            <div className="rounded-md bg-white p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">{text.evaluationFailures}</p>
                              <p className="mt-1 text-lg font-semibold text-slate-950">
                                {latestRun.hallucinationFailures + latestRun.handoffFailures + latestRun.redTeamFailures}
                              </p>
                            </div>
                            <div className="rounded-md bg-white p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">{text.testSetVersion}</p>
                              <p className="mt-1 break-words text-sm font-semibold text-slate-950">{latestRun.testSetVersion}</p>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-3 lg:grid-cols-[0.85fr_1.15fr]">
                            <div className="rounded-md bg-white p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">{text.evaluationCaseSummary}</p>
                              <div className="mt-3 grid gap-2 text-sm">
                                <div className="flex items-center justify-between gap-3 rounded-md bg-stone-50 px-3 py-2">
                                  <span className="break-words text-stone-600">{text.citationChecks}</span>
                                  <span className="shrink-0 font-semibold text-slate-950">
                                    {coveredCitationCases.length}/{Math.max(citationCases.length, 1)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-3 rounded-md bg-stone-50 px-3 py-2">
                                  <span className="break-words text-stone-600">{text.redTeamChecks}</span>
                                  <span className="shrink-0 font-semibold text-slate-950">
                                    {passedRedTeamCases.length}/{Math.max(redTeamCases.length, 1)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-3 rounded-md bg-stone-50 px-3 py-2">
                                  <span className="break-words text-stone-600">{text.failedCases}</span>
                                  <span className="shrink-0 font-semibold text-slate-950">{failedCases.length}</span>
                                </div>
                              </div>
                            </div>
                            <div className="rounded-md bg-white p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">{text.evaluationFailedCasesTitle}</p>
                              <div className="mt-3 space-y-2">
                                {failedCases.length ? (
                                  failedCases.map((evaluationCase) => (
                                    <div className="rounded-md border border-rose-100 bg-rose-50 p-3" key={evaluationCase.id}>
                                      <p className="break-words text-sm font-semibold text-rose-900">
                                        {text.evaluationCaseKindLabels[evaluationCase.kind]} - {evaluationCase.id}
                                      </p>
                                      <p className="mt-1 break-words text-xs text-rose-800">{evaluationCase.prompt}</p>
                                    </div>
                                  ))
                                ) : (
                                  <p className="rounded-md bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                                    {text.noFailedEvaluationCases}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 rounded-md bg-white p-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">{text.evaluationCaseDetails}</p>
                            <div className="mt-3 grid gap-2">
                              {latestRun.cases.length ? (
                                latestRun.cases.map((evaluationCase) => (
                                  <article className="rounded-md border border-stone-200 bg-stone-50 p-3" key={evaluationCase.id}>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                      <div className="min-w-0">
                                        <p className="break-words text-sm font-semibold text-slate-950">
                                          {text.evaluationCaseKindLabels[evaluationCase.kind]} - {evaluationCase.id}
                                        </p>
                                        <p className="mt-1 break-words text-xs text-stone-600">{evaluationCase.prompt}</p>
                                      </div>
                                      <Pill tone={evaluationCase.passed ? "green" : "rose"}>
                                        {evaluationCase.passed ? text.casePassed : text.caseFailed}
                                      </Pill>
                                    </div>
                                    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                                      <p className="rounded-md bg-white p-2 text-stone-600">
                                        <span className="font-semibold text-slate-900">{text.expectedResult}: </span>
                                        {text.evaluationExpectedLabels[evaluationCase.expected]}
                                      </p>
                                      <p className="rounded-md bg-white p-2 text-stone-600">
                                        <span className="font-semibold text-slate-900">{text.actualResult}: </span>
                                        {text.evaluationResultLabels[evaluationCase.result]}
                                      </p>
                                      <p className="rounded-md bg-white p-2 text-stone-600">
                                        {text.evaluationCaseSourceStats(evaluationCase.sourceCount, evaluationCase.citationCount)}
                                      </p>
                                    </div>
                                    {evaluationCase.riskFlags.length ? (
                                      <div className="mt-2 flex flex-wrap gap-2">
                                        {evaluationCase.riskFlags.map((flag) => (
                                          <Pill key={flag} tone="amber">{flag}</Pill>
                                        ))}
                                      </div>
                                    ) : null}
                                  </article>
                                ))
                              ) : (
                                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noEvaluationCases}</p>
                              )}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noBots}</p>
              )}
            </div>
          </article>
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{text.advancedTechnologyTitle}</h3>
                <p className="mt-1 text-sm text-stone-600">{text.advancedTechnologyDescription}</p>
              </div>
              <button
                aria-controls="bot-advanced-technology"
                aria-expanded={showAdvancedTechnology}
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-stone-50"
                onClick={() => setShowAdvancedTechnology((current) => !current)}
                type="button"
              >
                {showAdvancedTechnology ? text.hideAdvancedTechnology : text.showAdvancedTechnology}
              </button>
            </div>
            {showAdvancedTechnology ? (
              <div className="mt-5 grid gap-4 xl:grid-cols-[0.85fr_1.15fr]" id="bot-advanced-technology">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h4 className="text-base font-semibold text-slate-950">{text.developerTabTitle}</h4>
                  <p className="mt-1 text-sm text-stone-600">{text.developerTabDescription}</p>
                  <div className="mt-4 space-y-2 text-sm">
                    <div className="rounded-md bg-white p-3">
                      <p className="font-semibold text-slate-950">NOVALURE_BOT_WEBHOOK_SECRET</p>
                      <p className="mt-1 text-stone-600">{text.webhookSecretDescription}</p>
                    </div>
                    <div className="rounded-md bg-white p-3">
                      <p className="font-semibold text-slate-950">NOVALURE_BOT_WEBHOOK_VERIFY_TOKEN</p>
                      <p className="mt-1 text-stone-600">{text.verifyTokenDescription}</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h4 className="text-base font-semibold text-slate-950">{text.apiContracts}</h4>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {endpointCards.map((endpoint) => (
                      <div className="rounded-lg border border-stone-200 bg-white p-3" key={endpoint.id}>
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-slate-950">{text.endpointLabels[endpoint.id]}</p>
                          <span className="rounded-md bg-slate-950 px-2 py-1 text-xs font-semibold text-white">{endpoint.method}</span>
                        </div>
                        <p className="mt-2 break-words font-mono text-xs text-slate-700">{endpoint.path}</p>
                        <p className="mt-2 break-words text-xs text-stone-600">{text.endpointDescriptions[endpoint.id]}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </article>
        </section>
      ) : null}
    </section>
  );
}
