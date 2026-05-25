import type { AppSession } from "@/lib/auth/session";
import type { Deal, PropertyReservation, PropertyUnit, Task } from "@/lib/crm-types";
import { queryOne } from "@/lib/db/client";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { changeDealStageRecord, upsertTaskRecord } from "@/lib/db/crm-write-repositories";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { queueTeamsNotification } from "@/lib/db/teams-notification-repositories";

export type ReservationWorkflowAction = "create" | "extend" | "expire" | "convert";

export type ReservationWorkflowInput = {
  action: ReservationWorkflowAction;
  unitId?: string | null;
  reservationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  expiresAt?: string | null;
  depositCents?: number | null;
  contractMilestone?: string | null;
  nextAction?: string | null;
  createTask?: boolean;
  notifyTeams?: boolean;
};

export type PreparedTeamsNotification = {
  title: string;
  body: string;
  workspaceId: string;
  projectId: string;
  unitId: string;
  reservationId: string;
  dealId?: string | null;
  dueAt?: string | null;
  jobId?: string | null;
  queued?: boolean;
  reason?: string | null;
  status?: string | null;
};

export type ReservationWorkflowResult = {
  persisted: boolean;
  reason?: string;
  reservation?: PropertyReservation;
  unit?: PropertyUnit;
  deal?: Pick<Deal, "id" | "projectId" | "stage" | "nextAction" | "probability" | "closedAt">;
  task?: Task;
  teamsNotification?: PreparedTeamsNotification;
};

type UnitRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  building_id: string | null;
  unit_number: string;
  floor: number | null;
  rooms: number | string | null;
  area_sqm: number | string | null;
  price_cents: number | string | null;
  status: string | null;
  buyer_contact_id: string | null;
  deal_id: string | null;
  updated_at: Date | string | null;
};

type ReservationRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  unit_id: string;
  contact_id: string;
  deal_id: string | null;
  status: string | null;
  expires_at: Date | string | null;
  deposit_cents: number | string | null;
  contract_milestone: string | null;
  next_action: string | null;
};

type DealSyncRow = {
  id: string;
  project_id: string;
  stage: Deal["stage"];
  next_action: string | null;
  probability: number | string | null;
  closed_at: Date | string | null;
};

type DealPermissionRow = {
  id: string;
  owner_user_id: string | null;
  stage: Deal["stage"];
};

type PipelinePermissionRow = {
  can_close_deals: boolean | null;
  can_edit_deals: boolean | null;
  can_move_deals: boolean | null;
  can_reopen_deals: boolean | null;
};

type DealSyncResult =
  | {
      deal?: Pick<Deal, "id" | "projectId" | "stage" | "nextAction" | "probability" | "closedAt">;
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

const ACTIVE_RESERVATION_STATUSES = new Set(["hold", "reserved"]);

function cleanString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(value: number | string | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return new Date().toISOString();
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeContractMilestone(value: unknown): PropertyReservation["contractMilestone"] {
  return value === "offer_sent" ||
    value === "financing_check" ||
    value === "contract_draft" ||
    value === "signed" ||
    value === "not_started"
    ? value
    : "not_started";
}

function normalizeFutureDate(value: string | null | undefined) {
  const parsed = value ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  const fallback = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return fallback.toISOString();
}

function taskDueDate(expiresAt: string, action: ReservationWorkflowAction) {
  if (action === "expire" || action === "convert") {
    return new Date().toISOString();
  }

  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) {
    return new Date().toISOString();
  }

  const due = new Date(expires.getTime() - 24 * 60 * 60 * 1000);
  return due.getTime() > Date.now() ? due.toISOString() : new Date().toISOString();
}

function defaultNextAction(action: ReservationWorkflowAction, expiresAt: string) {
  const expiresDate = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(expiresAt));

  if (action === "expire") {
    return "Reservierung abgelaufen: Kontakt nachfassen und Einheit wieder anbieten.";
  }

  if (action === "convert") {
    return "Reservierung konvertiert: Vertrags- und Übergabeschritte abschließen.";
  }

  return `Reservierung bis ${expiresDate} nachfassen.`;
}

function toUnit(row: UnitRow, reservationId?: string | null): PropertyUnit {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    buildingId: row.building_id ?? "",
    unitNumber: row.unit_number,
    floor: row.floor ?? 0,
    rooms: toNumber(row.rooms),
    areaSqm: toNumber(row.area_sqm),
    priceCents: toNumber(row.price_cents),
    status: row.status === "reserved" || row.status === "sold" || row.status === "blocked" ? row.status : "available",
    buyerContactId: row.buyer_contact_id ?? undefined,
    dealId: row.deal_id ?? undefined,
    reservationId: reservationId ?? undefined,
    updatedAt: toIso(row.updated_at),
  };
}

function toReservation(row: ReservationRow): PropertyReservation {
  const status =
    row.status === "hold" || row.status === "reserved" || row.status === "expired" || row.status === "converted"
      ? row.status
      : "reserved";

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    unitId: row.unit_id,
    contactId: row.contact_id,
    dealId: row.deal_id ?? undefined,
    status,
    expiresAt: toIso(row.expires_at),
    depositCents: toNumber(row.deposit_cents),
    contractMilestone: normalizeContractMilestone(row.contract_milestone),
    nextAction: row.next_action ?? "",
  };
}

function toDeal(row: DealSyncRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    stage: row.stage,
    nextAction: row.next_action ?? "",
    probability: toNumber(row.probability),
    closedAt: row.closed_at ? toIso(row.closed_at) : undefined,
  };
}

async function loadUnit(session: AppSession, unitId: string) {
  if (!isUuid(unitId)) {
    return null;
  }

  return queryOne<UnitRow>(
    `
      select
        id,
        workspace_id,
        project_id,
        building_id,
        unit_number,
        floor,
        rooms,
        area_sqm,
        price_cents,
        status,
        buyer_contact_id,
        deal_id,
        updated_at
      from property_units
      where id = $1::uuid
        and workspace_id = $2::uuid
      limit 1
    `,
    [unitId, session.workspaceId],
  );
}

async function loadReservation(session: AppSession, reservationId: string) {
  if (!isUuid(reservationId)) {
    return null;
  }

  return queryOne<ReservationRow>(
    `
      select
        id,
        workspace_id,
        project_id,
        unit_id,
        contact_id,
        deal_id,
        status,
        expires_at,
        deposit_cents,
        contract_milestone,
        next_action
      from property_reservations
      where id = $1::uuid
        and workspace_id = $2::uuid
      limit 1
    `,
    [reservationId, session.workspaceId],
  );
}

async function loadActiveReservationForUnit(session: AppSession, unitId: string) {
  if (!isUuid(unitId)) {
    return null;
  }

  return queryOne<ReservationRow>(
    `
      select
        id,
        workspace_id,
        project_id,
        unit_id,
        contact_id,
        deal_id,
        status,
        expires_at,
        deposit_cents,
        contract_milestone,
        next_action
      from property_reservations
      where unit_id = $1::uuid
        and workspace_id = $2::uuid
        and status in ('hold', 'reserved')
      order by expires_at asc, id asc
      limit 1
    `,
    [unitId, session.workspaceId],
  );
}

async function validateContact(session: AppSession, projectId: string, contactId: string) {
  if (!isUuid(contactId)) {
    return false;
  }

  const row = await queryOne<{ id: string }>(
    `
      select id
      from contacts
      where id = $1::uuid
        and workspace_id = $2::uuid
        and project_id = $3::uuid
      limit 1
    `,
    [contactId, session.workspaceId, projectId],
  );

  return Boolean(row);
}

async function validateDeal(session: AppSession, projectId: string, dealId: string | null) {
  if (!dealId) {
    return true;
  }

  if (!isUuid(dealId)) {
    return false;
  }

  const row = await queryOne<{ id: string }>(
    `
      select id
      from deals
      where id = $1::uuid
        and workspace_id = $2::uuid
        and project_id = $3::uuid
      limit 1
    `,
    [dealId, session.workspaceId, projectId],
  );

  return Boolean(row);
}

function targetStageForAction(action: ReservationWorkflowAction): Deal["stage"] {
  return action === "convert" ? "Gewonnen" : action === "expire" ? "Qualifizieren" : "Angebot/Reservierung";
}

function isTerminalDealStage(stage: string | null | undefined) {
  return stage === "Gewonnen" || stage === "Verloren" || stage === "Disqualifiziert";
}

async function validateDealStagePermission(
  session: AppSession,
  projectId: string,
  dealId: string | null,
  action: ReservationWorkflowAction,
) {
  if (!dealId) {
    return { ok: true as const };
  }

  if (session.role === "owner" || session.role === "admin") {
    return { ok: true as const };
  }

  const deal = await queryOne<DealPermissionRow>(
    `
      select id, owner_user_id, stage
      from deals
      where id = $1::uuid
        and workspace_id = $2::uuid
        and project_id = $3::uuid
      limit 1
    `,
    [dealId, session.workspaceId, projectId],
  );

  if (!deal || !isUuid(session.userId)) {
    return { ok: false as const, reason: "Project pipeline permission is required." };
  }

  const targetStage = targetStageForAction(action);
  const isClosing = isTerminalDealStage(targetStage);
  const isReopening = isTerminalDealStage(deal.stage) && !isTerminalDealStage(targetStage);
  const permission = await queryOne<PipelinePermissionRow>(
    `
      select
        can_close_deals,
        can_edit_deals,
        can_move_deals,
        can_reopen_deals
      from project_pipeline_permissions
      where workspace_id = $1::uuid
        and project_id = $2::uuid
        and user_id = $3::uuid
      limit 1
    `,
    [session.workspaceId, projectId, session.userId],
  );

  if (permission) {
    const allowed = isReopening
      ? permission.can_reopen_deals
      : isClosing
        ? permission.can_close_deals
        : permission.can_move_deals;
    return allowed && permission.can_edit_deals
      ? { ok: true as const }
      : { ok: false as const, reason: "Project pipeline permission denied." };
  }

  if (deal.owner_user_id === session.userId && !isClosing && !isReopening) {
    return { ok: true as const };
  }

  return { ok: false as const, reason: "Project pipeline permission is required." };
}

async function writeUnitSync(
  session: AppSession,
  unit: UnitRow,
  reservation: ReservationRow,
  action: ReservationWorkflowAction,
  contactId: string,
  dealId: string | null,
) {
  if (action === "expire") {
    const updated = await queryOne<UnitRow>(
      `
        update property_units
        set
          status = 'available',
          buyer_contact_id = case when buyer_contact_id = $4::uuid then null else buyer_contact_id end,
          deal_id = case when deal_id = $5::uuid then null else deal_id end,
          metadata = coalesce(metadata, '{}'::jsonb) || $6::jsonb,
          updated_at = now()
        where id = $1::uuid
          and workspace_id = $2::uuid
          and project_id = $3::uuid
        returning
          id,
          workspace_id,
          project_id,
          building_id,
          unit_number,
          floor,
          rooms,
          area_sqm,
          price_cents,
          status,
          buyer_contact_id,
          deal_id,
          updated_at
      `,
      [
        unit.id,
        session.workspaceId,
        unit.project_id,
        contactId,
        dealId,
        JSON.stringify({ reservationWorkflow: { action, reservationId: reservation.id, syncedAt: new Date().toISOString() } }),
      ],
    );

    return updated;
  }

  const unitStatus = action === "convert" ? "sold" : "reserved";
  return queryOne<UnitRow>(
    `
      update property_units
      set
        status = $4,
        buyer_contact_id = $5::uuid,
        deal_id = $6::uuid,
        metadata = coalesce(metadata, '{}'::jsonb) || $7::jsonb,
        updated_at = now()
      where id = $1::uuid
        and workspace_id = $2::uuid
        and project_id = $3::uuid
      returning
        id,
        workspace_id,
        project_id,
        building_id,
        unit_number,
        floor,
        rooms,
        area_sqm,
        price_cents,
        status,
        buyer_contact_id,
        deal_id,
        updated_at
    `,
    [
      unit.id,
      session.workspaceId,
      unit.project_id,
      unitStatus,
      contactId,
      dealId,
      JSON.stringify({ reservationWorkflow: { action, reservationId: reservation.id, syncedAt: new Date().toISOString() } }),
    ],
  );
}

async function syncDeal(
  session: AppSession,
  projectId: string,
  dealId: string | null,
  action: ReservationWorkflowAction,
  nextAction: string,
): Promise<DealSyncResult> {
  if (!dealId) {
    return { ok: true };
  }

  const stage = targetStageForAction(action);
  const stageResult = await changeDealStageRecord({
    dealId,
    reasonCategory: action === "convert" ? "won" : undefined,
    session,
    toStage: stage,
  });

  if (!stageResult.persisted) {
    return { ok: false, reason: stageResult.reason };
  }

  const row = await queryOne<DealSyncRow>(
    `
      update deals
      set
        next_action = $4,
        probability = case
          when $5 = 'convert' then 100
          when $5 in ('create', 'extend') then greatest(coalesce(probability, 0), 75)
          else probability
        end,
        updated_at = now()
      where id = $1::uuid
        and workspace_id = $2::uuid
        and project_id = $3::uuid
      returning id, project_id, stage, next_action, probability, closed_at
    `,
    [dealId, session.workspaceId, projectId, nextAction, action],
  );

  return row ? { deal: toDeal(row), ok: true } : { ok: false, reason: "Deal could not be synchronized." };
}

async function writeReservationTask(
  session: AppSession,
  reservation: PropertyReservation,
  unit: PropertyUnit,
  action: ReservationWorkflowAction,
  nextAction: string,
) {
  const priority = new Date(reservation.expiresAt).getTime() - Date.now() <= 3 * 24 * 60 * 60 * 1000 ? "Hoch" : "Normal";
  const label =
    action === "convert"
      ? "Reservierung konvertieren"
      : action === "expire"
        ? "Reservierung nachfassen"
        : "Reservierungsfrist prüfen";

  const result = await upsertTaskRecord({
    session,
    task: {
      title: `${label}: Einheit ${unit.unitNumber} - ${nextAction}`,
      projectId: reservation.projectId,
      contactId: reservation.contactId,
      due: taskDueDate(reservation.expiresAt, action),
      priority,
      status: "open",
    },
  });

  return result.persisted ? result.data : undefined;
}

function buildTeamsNotification(
  session: AppSession,
  reservation: PropertyReservation,
  unit: PropertyUnit,
  action: ReservationWorkflowAction,
) {
  const verb =
    action === "convert" ? "konvertiert" : action === "expire" ? "abgelaufen" : action === "extend" ? "verlängert" : "erstellt";

  return {
    title: `Reservierung ${verb}: Einheit ${unit.unitNumber}`,
    body: `${unit.unitNumber} im Projekt ${reservation.projectId} wurde ${verb}. Nächste Aktion: ${reservation.nextAction}`,
    workspaceId: session.workspaceId,
    projectId: reservation.projectId,
    unitId: unit.id,
    reservationId: reservation.id,
    dealId: reservation.dealId ?? null,
    dueAt: reservation.expiresAt,
  } satisfies PreparedTeamsNotification;
}

async function queueReservationTeamsNotification(
  session: AppSession,
  reservation: PropertyReservation,
  unit: PropertyUnit,
  action: ReservationWorkflowAction,
) {
  const notification = buildTeamsNotification(session, reservation, unit, action);
  const result = await queueTeamsNotification({
    alertType: "reservation_workflow",
    contactId: reservation.contactId,
    dealId: reservation.dealId,
    entityId: reservation.id,
    entityType: "property_reservation",
    facts: [
      { name: "Einheit", value: unit.unitNumber },
      { name: "Status", value: reservation.status },
      { name: "Frist", value: reservation.expiresAt },
      { name: "Nächste Aktion", value: reservation.nextAction || "-" },
    ],
    idempotencyKey: `reservation_workflow:${reservation.id}:${action}`,
    message: notification.body,
    payload: {
      action,
      depositCents: reservation.depositCents,
      dueAt: reservation.expiresAt,
      reservationId: reservation.id,
      unitId: unit.id,
      unitNumber: unit.unitNumber,
    },
    projectId: reservation.projectId,
    session,
    severity: action === "expire" ? "critical" : action === "convert" ? "info" : "warning",
    summary: notification.body,
    title: notification.title,
  });

  return {
    ...notification,
    jobId: result.job?.id ?? null,
    queued: result.queued,
    reason: result.reason ?? null,
    status: result.job?.status ?? null,
  };
}

export async function mutateUnitReservation({
  session,
  input,
}: {
  session: AppSession;
  input: ReservationWorkflowInput;
}): Promise<ReservationWorkflowResult> {
  if (!canPersist()) {
    return { persisted: false, reason: "DATABASE_URL is not configured." };
  }

  if (!isUuid(session.workspaceId) || !isUuid(session.userId)) {
    return { persisted: false, reason: "A valid workspace and user are required." };
  }

  const action = input.action;
  const knownAction = action === "create" || action === "extend" || action === "expire" || action === "convert";
  if (!knownAction) {
    return { persisted: false, reason: "Unsupported reservation action." };
  }

  const existingReservation =
    action === "create"
      ? null
      : input.reservationId
        ? await loadReservation(session, input.reservationId)
        : input.unitId
          ? await loadActiveReservationForUnit(session, input.unitId)
          : null;

  const unitId = input.unitId ?? existingReservation?.unit_id ?? null;
  if (!unitId) {
    return { persisted: false, reason: "A unit is required." };
  }

  const unit = await loadUnit(session, unitId);
  if (!unit) {
    return { persisted: false, reason: "Unit was not found in this workspace." };
  }

  if (existingReservation && existingReservation.project_id !== unit.project_id) {
    return { persisted: false, reason: "Reservation and unit belong to different projects." };
  }

  if (action !== "create" && !existingReservation) {
    return { persisted: false, reason: "Active reservation was not found." };
  }

  if (action !== "create" && existingReservation && !ACTIVE_RESERVATION_STATUSES.has(existingReservation.status ?? "")) {
    return { persisted: false, reason: "Reservation is not active anymore." };
  }

  const contactId = input.contactId ?? existingReservation?.contact_id ?? unit.buyer_contact_id ?? null;
  if (!contactId) {
    return { persisted: false, reason: "A contact is required for the reservation." };
  }

  const contactIsValid = await validateContact(session, unit.project_id, contactId);
  if (!contactIsValid) {
    return { persisted: false, reason: "Contact does not belong to this workspace and project." };
  }

  const dealId = input.dealId ?? existingReservation?.deal_id ?? unit.deal_id ?? null;
  const dealIsValid = await validateDeal(session, unit.project_id, dealId);
  if (!dealIsValid) {
    return { persisted: false, reason: "Deal does not belong to this workspace and project." };
  }

  const dealStagePermission = await validateDealStagePermission(session, unit.project_id, dealId, action);
  if (!dealStagePermission.ok) {
    return { persisted: false, reason: dealStagePermission.reason };
  }

  const expiresAt = action === "expire" || action === "convert" ? toIso(existingReservation?.expires_at) : normalizeFutureDate(input.expiresAt);
  const nextAction = cleanString(input.nextAction) ?? defaultNextAction(action, expiresAt);
  const milestone = normalizeContractMilestone(cleanString(input.contractMilestone) ?? existingReservation?.contract_milestone);
  const depositCents = Number.isFinite(input.depositCents ?? Number.NaN)
    ? Math.max(0, Math.round(input.depositCents ?? 0))
    : toNumber(existingReservation?.deposit_cents);

  const metadata = JSON.stringify({
    reservationWorkflow: {
      action,
      userId: session.userId,
      workspaceId: session.workspaceId,
      projectId: unit.project_id,
      syncedAt: new Date().toISOString(),
    },
  });

  const reservationRow =
    action === "create"
      ? await queryOne<ReservationRow>(
          `
            insert into property_reservations (
              workspace_id,
              project_id,
              unit_id,
              contact_id,
              deal_id,
              status,
              expires_at,
              deposit_cents,
              contract_milestone,
              next_action,
              metadata
            )
            values (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              $5::uuid,
              'reserved',
              $6::timestamptz,
              $7,
              $8,
              $9,
              $10::jsonb
            )
            returning
              id,
              workspace_id,
              project_id,
              unit_id,
              contact_id,
              deal_id,
              status,
              expires_at,
              deposit_cents,
              contract_milestone,
              next_action
          `,
          [session.workspaceId, unit.project_id, unit.id, contactId, dealId ?? null, expiresAt, depositCents, milestone, nextAction, metadata],
        )
      : await queryOne<ReservationRow>(
          `
            update property_reservations
            set
              contact_id = $4::uuid,
              deal_id = $5::uuid,
              status = $6,
              expires_at = $7::timestamptz,
              deposit_cents = $8,
              contract_milestone = $9,
              next_action = $10,
              metadata = coalesce(metadata, '{}'::jsonb) || $11::jsonb,
              updated_at = now()
            where id = $1::uuid
              and workspace_id = $2::uuid
              and project_id = $3::uuid
            returning
              id,
              workspace_id,
              project_id,
              unit_id,
              contact_id,
              deal_id,
              status,
              expires_at,
              deposit_cents,
              contract_milestone,
              next_action
          `,
          [
            existingReservation?.id,
            session.workspaceId,
            unit.project_id,
            contactId,
            dealId ?? null,
            action === "expire" ? "expired" : action === "convert" ? "converted" : "reserved",
            expiresAt,
            depositCents,
            milestone,
            nextAction,
            metadata,
          ],
        );

  if (!reservationRow) {
    return { persisted: false, reason: "Reservation could not be saved." };
  }

  const updatedUnitRow = await writeUnitSync(session, unit, reservationRow, action, contactId, dealId);
  if (!updatedUnitRow) {
    return { persisted: false, reason: "Unit status could not be synchronized." };
  }

  const reservation = toReservation(reservationRow);
  const updatedUnit = toUnit(updatedUnitRow, reservation.id);
  const dealSync = await syncDeal(session, unit.project_id, dealId, action, nextAction);
  if (!dealSync.ok) {
    return { persisted: false, reason: dealSync.reason };
  }
  const syncedDeal = dealSync.deal;
  const task = input.createTask ? await writeReservationTask(session, reservation, updatedUnit, action, nextAction) : undefined;
  const teamsNotification = input.notifyTeams ? await queueReservationTeamsNotification(session, reservation, updatedUnit, action) : undefined;

  await writeAuditLog({
    session,
    action: `reservation.${action}`,
    entityType: "property_reservation",
    entityId: reservation.id,
    projectId: reservation.projectId,
    dealId: reservation.dealId,
    before: existingReservation ? toReservation(existingReservation) : null,
    after: { reservation, unit: updatedUnit, deal: syncedDeal, taskId: task?.id, teamsNotification },
  });

  await writeAuditLog({
    session,
    action: "reservation.unit_status_synced",
    entityType: "property_unit",
    entityId: updatedUnit.id,
    projectId: updatedUnit.projectId,
    dealId: updatedUnit.dealId,
    before: toUnit(unit, existingReservation?.id),
    after: updatedUnit,
  });

  if (teamsNotification) {
    await writeAuditLog({
      session,
      action: "reservation.teams_notification_queued",
      entityType: "property_reservation",
      entityId: reservation.id,
      projectId: reservation.projectId,
      dealId: reservation.dealId,
      before: null,
      after: teamsNotification,
    });
  }

  await writeCrmAnalyticsEvent({
    channel: "unit_board",
    contactId: reservation.contactId,
    dealId: reservation.dealId,
    entityId: reservation.id,
    entityType: "property_reservation",
    eventType: `reservation_${action}`,
    metadata: {
      action,
      contractMilestone: reservation.contractMilestone,
      depositCents: reservation.depositCents,
      nextAction: reservation.nextAction,
      reservationStatus: reservation.status,
      taskId: task?.id ?? null,
      teamsJobId: teamsNotification?.jobId ?? null,
      teamsStatus: teamsNotification?.status ?? null,
      unitId: updatedUnit.id,
      unitNumber: updatedUnit.unitNumber,
      unitStatus: updatedUnit.status,
    },
    module: "pipeline",
    projectId: reservation.projectId,
    source: "unit_board",
    userId: session.userId,
    valueCents: updatedUnit.priceCents,
    workspaceId: session.workspaceId,
  });

  return {
    persisted: true,
    reservation,
    unit: updatedUnit,
    deal: syncedDeal,
    task,
    teamsNotification,
  };
}
