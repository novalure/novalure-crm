import { NextResponse } from "next/server";
import { requirePermission, resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { botChannelConnectors, botSelfServeSetup } from "@/lib/bots/omnichannel";
import { getBotPolicyRules, getBotRuntimeControls } from "@/lib/bots/policy";
import {
  upsertBotChannelAccount,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { readBotChannelHistory } from "@/lib/db/crm-operational-readers";
import { operationalReadErrorResponse, operationalReadJson, parseOperationalReadQuery } from "@/lib/operational-read-http";

export const maxDuration = 30;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const scope = parseOperationalReadQuery(request, "bot");
    const auth = await resolveWorkspaceScopedSession(request, { permission: "bots:run" });
    if (!auth.ok) {
      auth.response.headers.set("cache-control", "private, no-store");
      auth.response.headers.set("x-content-type-options", "nosniff");
      auth.response.headers.set("referrer-policy", "no-referrer");
      return auth.response;
    }
    const { channelAccounts, recentWebhookEvents } = await readBotChannelHistory(auth.session, scope);
    return operationalReadJson({
      autonomyControls: getBotRuntimeControls(),
      channelAccounts,
      connectors: botChannelConnectors,
      policyRules: getBotPolicyRules(),
      recentWebhookEvents,
      selfServeSetup: botSelfServeSetup,
      webhookSecretHeader: "x-novalure-webhook-secret",
      source: "database",
    });
  } catch (error) {
    return operationalReadErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const channel = typeof input.channel === "string" ? input.channel : "";
  const connector = botChannelConnectors.find((item) => item.channel === channel);

  if (!connector) {
    return NextResponse.json({ error: "Unsupported bot channel" }, { status: 400 });
  }

  const accessToken = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
  const phoneNumberId = typeof input.phoneNumberId === "string" ? input.phoneNumberId.trim() : "";
  const whatsappBusinessAccountId =
    typeof input.whatsappBusinessAccountId === "string" ? input.whatsappBusinessAccountId.trim() : "";
  const pageId = typeof input.pageId === "string" ? input.pageId.trim() : "";
  const instagramAccountId = typeof input.instagramAccountId === "string" ? input.instagramAccountId.trim() : "";
  const graphVersion =
    typeof input.graphVersion === "string" && input.graphVersion.trim() ? input.graphVersion.trim() : "v23.0";
  const externalAccountId =
    channel === "WhatsApp"
      ? phoneNumberId
      : channel === "Instagram"
        ? instagramAccountId || pageId
        : channel === "Facebook Messenger"
          ? pageId
          : typeof input.externalAccountId === "string"
            ? input.externalAccountId.trim()
            : "";
  const shouldPersist = Boolean(accessToken && externalAccountId);
  const accountId = shouldPersist
    ? await upsertBotChannelAccount({
        active: true,
        accountLabel: typeof input.accountLabel === "string" ? input.accountLabel : connector.provider,
        botId: typeof input.botId === "string" ? input.botId : null,
        channel: connector.channel,
        complianceNote: connector.complianceNote,
        credentials: {
          accessToken,
          graphVersion,
          instagramAccountId,
          pageId,
          phoneNumberId,
          whatsappBusinessAccountId,
        },
        externalAccountId,
        inboundMode: connector.inboundMode,
        metadata: {
          connectedBy: auth.session.email,
          connectedAt: new Date().toISOString(),
          customerOwnedAccount: true,
        },
        outboundMode: connector.outboundMode,
        provider: connector.provider,
        session: auth.session,
        setupStatus: "connected",
        webhookPath: connector.webhookPath,
      })
    : null;
  const connection = {
    id: accountId ?? crypto.randomUUID(),
    active: Boolean(accountId),
    botId: typeof input.botId === "string" ? input.botId : null,
    channel: connector.channel,
    complianceNote: connector.complianceNote,
    externalAccountId: externalAccountId || null,
    inboundMode: connector.inboundMode,
    outboundMode: connector.outboundMode,
    provider: connector.provider,
    setupStatus: accountId ? "connected" : "ready",
    setupSteps: connector.setupSteps,
    webhookPath: connector.webhookPath,
  };

  await writeAuditLog({
    session: auth.session,
    action: "bot_channel.connection_prepared",
    entityType: "bot_channel_account",
    entityId: null,
    after: connection,
  });

  return NextResponse.json({
    connection,
    persisted: Boolean(accountId),
    status: accountId ? "connected" : "ready_for_customer_setup",
  }, { status: 201 });
}
