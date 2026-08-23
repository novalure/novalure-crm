import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import {
  assertQaBatchForMutation,
  assertQaBatchOwnsObject,
} from "@/lib/db/qa-batch-registration-repository";
import {
  withTenantTransaction,
  type TenantTransaction,
} from "@/lib/db/tenant-client";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const publishTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,128}$/u;

type FunnelPublicationRow = {
  id: string;
  projectId: string | null;
  tracking: unknown;
};

export type FunnelPublishTokenRotationResult =
  | {
      publishToken: string;
      replayed: false;
      revision: number;
      status: "rotated";
    }
  | {
      replayed: true;
      revision: number;
      status: "already-rotated";
    };

export class FunnelPublishTokenRotationError extends Error {
  readonly code:
    | "FUNNEL_NOT_FOUND"
    | "INVALID_FUNNEL_ID"
    | "INVALID_IDEMPOTENCY_KEY"
    | "INVALID_REVISION"
    | "PUBLICATION_REVISION_CONFLICT"
    | "ROTATION_PERSISTENCE_FAILED";
  readonly currentRevision?: number;

  constructor(
    code: FunnelPublishTokenRotationError["code"],
    options: { currentRevision?: number } = {},
  ) {
    super(code);
    this.name = "FunnelPublishTokenRotationError";
    this.code = code;
    this.currentRevision = options.currentRevision;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readRevision(tracking: Record<string, unknown>) {
  const value = tracking.publicationRevision;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function hashRotationRequest(idempotencyKey: string) {
  return createHash("sha256")
    .update("novalure:funnel-publication-rotation:v1\n", "utf8")
    .update(idempotencyKey, "utf8")
    .digest("hex");
}

function validateRotationInput(input: {
  expectedRevision: number;
  funnelId: string;
  idempotencyKey: string;
}) {
  if (!uuidPattern.test(input.funnelId)) {
    throw new FunnelPublishTokenRotationError("INVALID_FUNNEL_ID");
  }
  if (!idempotencyKeyPattern.test(input.idempotencyKey)) {
    throw new FunnelPublishTokenRotationError("INVALID_IDEMPOTENCY_KEY");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new FunnelPublishTokenRotationError("INVALID_REVISION");
  }
}

async function findFunnelPublicationRow(
  transaction: TenantTransaction,
  workspaceId: string,
  funnelId: string,
  lock: boolean,
) {
  return transaction.queryOne<FunnelPublicationRow>(
    `
      select
        id,
        project_id as "projectId",
        tracking
      from funnels
      where workspace_id = $1::uuid
        and id = $2::uuid
      ${lock ? "for update" : ""}
    `,
    [workspaceId, funnelId],
  );
}

export async function rotateFunnelPublishTokenInTransaction(input: {
  actorUserId: string;
  expectedRevision: number;
  funnelId: string;
  idempotencyKey: string;
  tokenFactory?: () => string;
  transaction: TenantTransaction;
  workspaceId: string;
}): Promise<FunnelPublishTokenRotationResult> {
  validateRotationInput(input);
  const row = await findFunnelPublicationRow(
    input.transaction,
    input.workspaceId,
    input.funnelId,
    true,
  );
  if (!row) throw new FunnelPublishTokenRotationError("FUNNEL_NOT_FOUND");

  const tracking = asRecord(row.tracking);
  const revision = readRevision(tracking);
  const requestHash = hashRotationRequest(input.idempotencyKey);
  if (tracking.publicationRotationRequestHash === requestHash) {
    return { replayed: true, revision, status: "already-rotated" };
  }
  if (revision !== input.expectedRevision) {
    throw new FunnelPublishTokenRotationError("PUBLICATION_REVISION_CONFLICT", {
      currentRevision: revision,
    });
  }

  const publishToken = input.tokenFactory?.() ?? randomBytes(32).toString("base64url");
  if (!publishTokenPattern.test(publishToken)) {
    throw new FunnelPublishTokenRotationError("ROTATION_PERSISTENCE_FAILED");
  }
  const nextRevision = revision + 1;
  const nextTracking = {
    ...tracking,
    publicToken: publishToken,
    publicationRevision: nextRevision,
    publicationRotationRequestHash: requestHash,
    publishToken,
  };
  const updated = await input.transaction.queryOne<{ id: string }>(
    `
      update funnels
      set tracking = $3::jsonb,
          updated_at = now()
      where workspace_id = $1::uuid
        and id = $2::uuid
      returning id
    `,
    [input.workspaceId, input.funnelId, JSON.stringify(nextTracking)],
  );
  if (!updated) {
    throw new FunnelPublishTokenRotationError("ROTATION_PERSISTENCE_FAILED");
  }

  const audited = await input.transaction.queryOne<{ id: string }>(
    `
      insert into audit_logs (
        workspace_id,
        project_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        before,
        after
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'funnel.publication_credential_rotated',
        'funnel',
        $4::uuid,
        $5::jsonb,
        $6::jsonb
      )
      returning id
    `,
    [
      input.workspaceId,
      row.projectId,
      input.actorUserId,
      input.funnelId,
      JSON.stringify({ publicationRevision: revision }),
      JSON.stringify({ publicationRevision: nextRevision }),
    ],
  );
  if (!audited) {
    throw new FunnelPublishTokenRotationError("ROTATION_PERSISTENCE_FAILED");
  }

  return {
    publishToken,
    replayed: false,
    revision: nextRevision,
    status: "rotated",
  };
}

export async function rotateFunnelPublishToken(input: {
  expectedRevision: number;
  funnelId: string;
  idempotencyKey: string;
  qaBatchId?: string;
  session: AppSession;
}) {
  validateRotationInput(input);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      if (input.qaBatchId) {
        await assertQaBatchForMutation(transaction, {
          batchId: input.qaBatchId,
          workspaceId: input.session.workspaceId,
        });
        await assertQaBatchOwnsObject(transaction, {
          batchId: input.qaBatchId,
          object: { id: input.funnelId, type: "funnels" },
          workspaceId: input.session.workspaceId,
        });
      }
      return rotateFunnelPublishTokenInTransaction({
        actorUserId: input.session.userId,
        expectedRevision: input.expectedRevision,
        funnelId: input.funnelId,
        idempotencyKey: input.idempotencyKey,
        transaction,
        workspaceId: input.session.workspaceId,
      });
    },
  );
}

export async function getFunnelPublishTokenRotationStatus(input: {
  funnelId: string;
  session: AppSession;
}) {
  if (!uuidPattern.test(input.funnelId)) {
    throw new FunnelPublishTokenRotationError("INVALID_FUNNEL_ID");
  }
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const row = await findFunnelPublicationRow(
        transaction,
        input.session.workspaceId,
        input.funnelId,
        false,
      );
      if (!row) throw new FunnelPublishTokenRotationError("FUNNEL_NOT_FOUND");
      return { revision: readRevision(asRecord(row.tracking)) };
    },
  );
}
