import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const dnsNamespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const fixtureScope = "novalure.qa-public-form-candidate.v1";

function workspaceId(prefix, side) {
  const bytes = createHash("sha1").update(dnsNamespace).update([fixtureScope, prefix, side].join("/")).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function candidateFixtureScope(runPrefix) {
  if (typeof runPrefix !== "string" || !/^GOLIVETEST_[1-9][0-9]*_[1-9][0-9]*$/u.test(runPrefix)) {
    throw new Error("QA_CANDIDATE_RUN_SCOPE_INVALID");
  }
  // The GitHub attempt owns this scope even when the checked-out SHA changes.
  const marker = createHash("sha256").update(fixtureScope + "/" + runPrefix).digest("hex").slice(0, 24);
  return {
    marker,
    own: { workspace: workspaceId(runPrefix, "own"), key: "qa-" + marker },
    foreign: { workspace: workspaceId(runPrefix, "foreign"), key: "qa-foreign-" + marker },
  };
}

export async function reserveCandidateWorkspaces(pool, scope, runnerTemp) {
  if (typeof runnerTemp !== "string" || !isAbsolute(runnerTemp)) {
    throw new Error("QA_CANDIDATE_RUN_TEMP_INVALID");
  }
  // This marker survives an uncertain database result on this runner. GitHub
  // gives a re-run a new attempt; do not retry a claim within the same attempt.
  try {
    await writeFile(join(runnerTemp, "novalure-public-candidate-" + scope.marker + ".once"), "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new Error(error?.code === "EEXIST" ? "QA_CANDIDATE_RUN_ALREADY_USED" : "QA_CANDIDATE_RUN_LOCK_UNCONFIRMED");
  }

  // Use the owner pool in autocommit. Both workspaces are a permanent claim
  // before later seed operations, whose rollback must not release the claim.
  let result;
  try {
    result = await pool.query(
      `insert into public.workspaces(id,name,operating_model,public_key)
       values($1,$2,'self_service_customer',$3),($4,$2,'self_service_customer',$5)`,
      [scope.own.workspace, "SYNTHETIC Candidate " + scope.marker, scope.own.key, scope.foreign.workspace, scope.foreign.key],
    );
  } catch (error) {
    throw new Error(error?.code === "23505" ? "QA_CANDIDATE_RUN_ALREADY_USED" : "QA_CANDIDATE_RUN_RESERVATION_UNCONFIRMED");
  }
  if (result.rowCount !== 2) throw new Error("QA_CANDIDATE_RUN_RESERVATION_UNCONFIRMED");
}

export async function seedCandidateIntegration(client, fixture, key, allowedOrigin) {
  // The published-form trigger may already have inserted the integration and
  // its widget. Only that exact fixture's records can be updated.
  const integration = await client.query(`insert into public.external_integrations as existing(
      public_site_key,workspace_id,project_id,form_id,integration_type,status,mode,
      allowed_origins,capabilities,configuration,metadata
    ) values($1,$2,$3,$4,'public_form','active','training',array[$5],
      array['form.read','form.submit','lead.create','chat.start','chat.context','chat.message'],'{}','{"synthetic":true}')
    on conflict(public_site_key) do update set
      allowed_origins=excluded.allowed_origins,
      capabilities=excluded.capabilities,
      status='active',
      mode='training',
      metadata=existing.metadata || excluded.metadata
    where existing.workspace_id=excluded.workspace_id
      and existing.project_id=excluded.project_id and existing.form_id=excluded.form_id
    returning id`, [key, fixture.workspace, fixture.project, fixture.form, allowedOrigin]);
  if (integration.rowCount !== 1) throw new Error("QA_CANDIDATE_INTEGRATION_SCOPE_CONFLICT");

  const widget = await client.query(`insert into public.external_integration_widget_configs as existing(
      integration_id,workspace_id,brand_name,assistant_name,enabled_capabilities,
      lead_capture_enabled,chat_enabled
    ) values($1,$2,'SYNTHETIC Candidate','Evelyn',
      array['form.read','form.submit','lead.create','chat.start','chat.context','chat.message'],true,true)
    on conflict(integration_id) do update set
      enabled_capabilities=excluded.enabled_capabilities,
      lead_capture_enabled=true,
      chat_enabled=true
    where existing.workspace_id=excluded.workspace_id`, [integration.rows[0].id, fixture.workspace]);
  if (widget.rowCount !== 1) throw new Error("QA_CANDIDATE_WIDGET_SCOPE_CONFLICT");
}
