import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { countActiveWorkspaceProjects } from "../src/lib/crm-presentation-data";
import { GET as getCrmCore } from "../src/app/api/crm/core/route";
import { GET, POST, PATCH } from "../src/app/api/workspaces/route";

// Uses a new disposable loopback PostgreSQL database, real cookie/CSRF routes,
// and the existing runtime role/RLS. No provider credentials are consumed.
test("workspace settings commit with their audit and fail atomically", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db);
    const fixture = await seedSalesBrowser(db);
    // The historical sales fixture grants bootstrap SELECT only. Reproduce the
    // existing production workspace UPDATE permission observed by the live PATCH;
    // audit policies and all append-only protections stay unchanged.
    await db.admin.query(`grant update(operating_model,customer_type,team_structure,active_calendar_provider,setup_state,updated_at) on workspaces to ${db.role}`);
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000";
    Object.assign(process.env, {
      DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,
      NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret,
      NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1",
      NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"),
      NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex"),
    });
    const cookie = "v2." + randomBytes(32).toString("base64url");
    await db.admin.query("update auth_identities set mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [fixture.authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), fixture.authIdentityId, fixture.userId, fixture.workspaceId]);
    const request = (path: string, method: string, body: unknown) => new Request(origin + path, {
      method, headers: { "content-type": "application/json", cookie: "novalure_session=" + cookie,
        origin, "sec-fetch-site": "same-origin", "x-novalure-csrf-token": createCsrfToken({
          method, pathname: path.split("?")[0], secret, sessionCookie: cookie,
        })!.token }, body: JSON.stringify(body),
    });
    const provision = await POST(request("/api/workspaces", "POST", {
      name: "SYNTHETIC workspace settings", projectName: "SYNTHETIC settings project",
      botName: "SYNTHETIC draft bot", websiteUrl: "https://example.com/synthetic-settings",
      customerType: "property_developer", requestId: randomUUID(),
    }));
    assert.equal(provision.status, 201, await provision.clone().text());
    const created = await provision.json(), workspaceId: string = created.workspace.id;
    const archivedProjectId = randomUUID();
    const path = `/api/workspaces?workspaceId=${workspaceId}`;
    const membership = (await db.admin.query("select id from workspace_users where workspace_id=$1 and auth_identity_id=$2", [workspaceId, fixture.authIdentityId])).rows[0].id;
    const saved = () => db.admin.query("select setup_state,operating_model,customer_type,team_structure,active_calendar_provider from workspaces where id=$1", [workspaceId]).then(result => result.rows[0]);
    const originBefore = (await db.admin.query("select setup_state from workspaces where id=$1", [fixture.workspaceId])).rows[0];

    await t.test("workspace summaries count active projects in each membership scope", async () => {
      await db.admin.query("insert into projects(id,workspace_id,name,type,status) values($1,$2,'SYNTHETIC archived','Bauträger','Archiviert')", [archivedProjectId, workspaceId]);
      const hiddenWorkspace = randomUUID();
      await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC unrelated','managed_by_novalure')", [hiddenWorkspace]);
      await db.admin.query("insert into projects(workspace_id,name,type,status) values($1,'SYNTHETIC hidden','Bauträger','Aktiv')", [hiddenWorkspace]);
      const response = await GET(new Request(origin + "/api/workspaces", { headers: { cookie: "novalure_session=" + cookie } }));
      assert.equal(response.status, 200, await response.clone().text());
      const payload = await response.json();
      assert.equal(payload.workspaces.find((item: { id: string }) => item.id === workspaceId).activeProjects, 1);
      assert.equal(payload.workspaces.find((item: { id: string }) => item.id === fixture.workspaceId).activeProjects, 1);
      assert.equal(payload.workspaces.some((item: { id: string }) => item.id === hiddenWorkspace), false);
    });

    await t.test("scoped admin cookie updates the target workspace and writes the matching RLS audit", async () => {
      const response = await PATCH(request(path, "PATCH", { setupState: { enabledModules: { newsletter: true, tasks: true }, syntheticMarker: "persisted" } }));
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.persisted, true);
      assert.equal(result.workspace.id, workspaceId);
      const state = await saved();
      assert.equal(state.setup_state.syntheticMarker, "persisted");
      assert.equal(state.setup_state.enabledModules.newsletter, true);
      assert.equal(state.setup_state.updatedByUserId, membership);
      assert.equal(state.operating_model, "managed_by_novalure");
      assert.equal(state.active_calendar_provider, "none");
      const audits = (await db.admin.query("select actor_user_id,before,after from audit_logs where workspace_id=$1 and action='workspace.setup_updated'", [workspaceId])).rows;
      assert.equal(audits.length, 1);
      assert.equal(audits[0].actor_user_id, membership);
      assert.equal(audits[0].before.setupState.syntheticMarker, undefined);
      assert.equal(audits[0].after.setupState.syntheticMarker, "persisted");
      assert.deepEqual((await db.admin.query("select setup_state from workspaces where id=$1", [fixture.workspaceId])).rows[0], originBefore);
    });

    await t.test("audit failure rolls back the settings and returns a safe JSON failure", async () => {
      const before = await saved();
      // Synthetic fault injection adds a rejection; it never disables audit/RLS.
      await db.admin.query("create function synthetic_reject_workspace_settings_audit() returns trigger language plpgsql as $$ begin if new.action='workspace.setup_updated' then raise exception 'SYNTHETIC audit unavailable'; end if; return new; end $$; create trigger synthetic_workspace_settings_audit before insert on audit_logs for each row execute function synthetic_reject_workspace_settings_audit()");
      try {
        for (const input of [
          { setupState: { syntheticMarker: "must roll back" } },
          { activeCalendarProvider: "google", workspaceSetupChange: { field: "activeCalendarProvider", expectedValue: before.active_calendar_provider } },
        ]) {
          const response = await PATCH(request(path, "PATCH", input));
          assert.equal(response.status, 503);
          assert.doesNotMatch(await response.text(), /SYNTHETIC audit unavailable|audit_logs/);
          assert.deepEqual(await saved(), before);
          assert.equal(Number((await db.admin.query("select count(*) from audit_logs where workspace_id=$1 and action='workspace.setup_updated'", [workspaceId])).rows[0].count), 1);
        }
      } finally {
        await db.admin.query("drop trigger synthetic_workspace_settings_audit on audit_logs; drop function synthetic_reject_workspace_settings_audit()");
      }
    });

    await t.test("concurrent field changes preserve each other and stale or invalid changes do not write", async () => {
      const before = await saved();
      const [calendar, team] = await Promise.all([
        PATCH(request(path, "PATCH", {
          activeCalendarProvider: "google",
          teamStructure: "no_sales_team",
          setupState: { syntheticMarker: "must not change" },
          workspaceSetupChange: { field: "activeCalendarProvider", expectedValue: before.active_calendar_provider },
        })),
        PATCH(request(path, "PATCH", {
          teamStructure: "project_sales_available",
          workspaceSetupChange: { field: "teamStructure", expectedValue: before.team_structure },
        })),
      ]);
      assert.equal(calendar.status, 200, await calendar.clone().text());
      assert.equal(team.status, 200, await team.clone().text());
      const state = await saved();
      assert.equal(state.active_calendar_provider, "google");
      assert.equal(state.team_structure, "project_sales_available");
      assert.equal(state.setup_state.syntheticMarker, "persisted");
      const stale = await PATCH(request(path, "PATCH", {
        activeCalendarProvider: "microsoft",
        workspaceSetupChange: { field: "activeCalendarProvider", expectedValue: before.active_calendar_provider },
      }));
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, "WORKSPACE_SETUP_CONFLICT");
      const invalid = await PATCH(request(path, "PATCH", {
        activeCalendarProvider: "microsoft",
        workspaceSetupChange: { field: "activeCalendarProvider" },
      }));
      assert.equal(invalid.status, 400);
      assert.deepEqual(await saved(), state);
      const audits = (await db.admin.query("select before,after from audit_logs where workspace_id=$1 and action='workspace.setup_updated'", [workspaceId])).rows;
      assert.equal(audits.length, 3);
      const calendarAudit = audits.find(audit => audit.before.activeCalendarProvider !== audit.after.activeCalendarProvider);
      const teamAudit = audits.find(audit => audit.before.teamStructure !== audit.after.teamStructure);
      assert.equal(calendarAudit.before.activeCalendarProvider, before.active_calendar_provider);
      assert.equal(calendarAudit.after.activeCalendarProvider, "google");
      assert.equal(teamAudit.before.teamStructure, before.team_structure);
      assert.equal(teamAudit.after.teamStructure, "project_sales_available");
      assert.deepEqual((await db.admin.query("select setup_state from workspaces where id=$1", [fixture.workspaceId])).rows[0], originBefore);
    });

    await t.test("current viewer membership cannot change settings through an existing internal cookie", async () => {
      const before = await saved();
      await db.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [membership]);
      const response = await PATCH(request(path, "PATCH", { setupState: { syntheticMarker: "forbidden" } }));
      assert.equal(response.status, 403);
      assert.deepEqual(await saved(), before);
    });

    await t.test("project-restricted membership summaries count only readable projects", async () => {
      await db.admin.query("insert into projects(workspace_id,name,type,status) values($1,'SYNTHETIC unauthorized active project','Bauträger','Aktiv')", [workspaceId]);
      await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$4,true,false),($1,$3,$4,true,false)", [workspaceId, created.project.id, archivedProjectId, membership]);
      assert.equal(Number((await db.admin.query("select count(*) from projects where workspace_id=$1 and status<>'Archiviert'", [workspaceId])).rows[0].count), 2);
      const response = await GET(new Request(origin + "/api/workspaces", { headers: { cookie: "novalure_session=" + cookie } }));
      assert.equal(response.status, 200, await response.clone().text());
      const payload = await response.json();
      assert.equal(payload.workspaces.find((item: { id: string }) => item.id === workspaceId).activeProjects, 1);

      const coreResponse = await getCrmCore(new Request(`${origin}/api/crm/core?workspaceId=${workspaceId}`, { headers: { cookie: "novalure_session=" + cookie } }));
      assert.equal(coreResponse.status, 200, await coreResponse.clone().text());
      const core = await coreResponse.json();
      assert.equal(core.moduleSources.projects, "database");
      assert.deepEqual(core.data.projects.map((project: { id: string }) => project.id).sort(), [archivedProjectId, created.project.id].sort());
      assert.equal(countActiveWorkspaceProjects(core.data.projects, workspaceId), 1);
    });
  } finally {
    await closeLocalTestPool();
    await db.stop();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});
