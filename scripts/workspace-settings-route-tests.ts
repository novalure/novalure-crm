import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { hashOpaqueToken } from "../src/lib/auth/auth-security";
import { confirmPasswordReset, createMembershipPasswordResetLink, createPasswordResetFormToken, exchangePasswordResetToken, hasValidPasswordResetExchange, passwordResetExchangeCookieName } from "../src/lib/auth/password-reset";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { countActiveWorkspaceProjects } from "../src/lib/crm-presentation-data";
import { NOVALURE_GROWTH_WORKSPACE_ID } from "../src/lib/product-model";
import { GET as getCrmCore } from "../src/app/api/crm/core/route";
import { PATCH as patchWorkspaceAccess } from "../src/app/api/settings/access/users/route";
import { PATCH as patchCustomerAccess } from "../src/app/api/crm/customer-access/route";
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
    // Match the membership mutation columns used by the authenticated QA runtime.
    await db.admin.query(`grant update(role,status,product_role,updated_at,password_hash) on workspace_users to ${db.role}`);
    await db.admin.query(`grant select on auth_password_reset_tokens to ${db.role}; grant insert, update(used_at,exchanged_at) on auth_password_reset_tokens to ${db.role}`);
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
    const request = (path: string, method: string, body: unknown, requestCookie = cookie) => new Request(origin + path, {
      method, headers: { "content-type": "application/json", cookie: "novalure_session=" + requestCookie,
        origin, "sec-fetch-site": "same-origin", "x-novalure-csrf-token": createCsrfToken({
          method, pathname: path.split("?")[0], secret, sessionCookie: requestCookie,
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

    await t.test("membership suspension, session revocation and audit are one scoped transaction", async () => {
      const viewerId = randomUUID();
      const viewerEmail = `synthetic-viewer-${viewerId}@example.invalid`;
      const viewer = (await db.admin.query(
        "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Viewer',$3,'assistant','viewer','active') returning auth_identity_id",
        [viewerId, workspaceId, viewerEmail],
      )).rows[0];
      await db.admin.query("update auth_identities set credential_state='active' where id=$1", [viewer.auth_identity_id]);
      const viewerCookie = "v2." + randomBytes(32).toString("base64url");
      const viewerSessionId = randomUUID();
      await db.admin.query(
        "insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,expires_at) values($1,$2,$3,$4,$5,now()+interval '1 hour')",
        [viewerSessionId, createHash("sha256").update(viewerCookie).digest("hex"), viewer.auth_identity_id, viewerId, workspaceId],
      );
      const viewerCore = () => getCrmCore(new Request(origin + "/api/crm/core", { headers: { cookie: "novalure_session=" + viewerCookie } }));
      const suspend = () => patchWorkspaceAccess(request(`/api/settings/access/users?workspaceId=${workspaceId}`, "PATCH", { userId: viewerId, status: "suspended" }));
      const current = async () => (await db.admin.query(
        "select u.status,s.revoked_at is not null as revoked,i.credential_state from workspace_users u join auth_identities i on i.id=u.auth_identity_id join auth_sessions s on s.workspace_user_id=u.id where u.id=$1 and s.id=$2",
        [viewerId, viewerSessionId],
      )).rows[0];
      const audits = async () => (await db.admin.query(
        "select actor_user_id,before->>'status' as before,after->>'status' as after from audit_logs where entity_id=$1 and action='customer_access.workspace_user_updated'",
        [viewerId],
      )).rows;
      assert.equal((await viewerCore()).status, 200);
      await db.admin.query("create function synthetic_reject_membership_audit() returns trigger language plpgsql as $$ begin if new.action='customer_access.workspace_user_updated' then raise exception 'SYNTHETIC membership audit unavailable'; end if; return new; end $$; create trigger synthetic_membership_audit before insert on audit_logs for each row execute function synthetic_reject_membership_audit()");
      try {
        const failed = await suspend();
        assert.equal(failed.status, 503);
        assert.doesNotMatch(await failed.text(), /SYNTHETIC membership audit unavailable|audit_logs/);
        assert.deepEqual(await current(), { status: "active", revoked: false, credential_state: "active" });
        assert.deepEqual(await audits(), []);
        assert.equal((await viewerCore()).status, 200);
      } finally {
        await db.admin.query("drop trigger synthetic_membership_audit on audit_logs; drop function synthetic_reject_membership_audit()");
      }
      const result = await suspend();
      assert.equal(result.status, 200, await result.clone().text());
      const payload = await result.json();
      assert.equal(payload.users.find((user: { id: string }) => user.id === viewerId).status, "suspended");
      assert.deepEqual(await current(), { status: "suspended", revoked: true, credential_state: "disabled" });
      assert.deepEqual(await audits(), [{ actor_user_id: membership, before: "active", after: "suspended" }]);
      assert.deepEqual((await db.admin.query(
        "select event_type from auth_audit_events where workspace_user_id=$1 and event_type in ('auth.membership.access_updated','auth.session.revoked') order by event_type",
        [viewerId],
      )).rows, [{ event_type: "auth.membership.access_updated" }, { event_type: "auth.session.revoked" }]);
      assert.equal((await viewerCore()).status, 401);
    });

    await t.test("suspending one membership leaves the shared login and another workspace active", async () => {
      const viewerId = randomUUID(), otherUserId = randomUUID(), otherWorkspaceId = randomUUID();
      const email = `synthetic-shared-${viewerId}@example.invalid`;
      await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC other workspace','managed_by_novalure')", [otherWorkspaceId]);
      await db.admin.query(
        "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC shared viewer',$5,'assistant','viewer','active'),($3,$4,'SYNTHETIC shared viewer',$5,'assistant','viewer','active')",
        [viewerId, workspaceId, otherUserId, otherWorkspaceId, email],
      );
      const identity = (await db.admin.query("update auth_identities set credential_state='active' where normalized_email=$1 returning id", [email])).rows[0].id;
      async function issueReset(bound: boolean) {
        let token: string;
        if (bound) {
          const link = await createMembershipPasswordResetLink({ language: "de", workspaceId, workspaceUserId: viewerId });
          const secret = new URLSearchParams(new URL(link.resetUrl).hash.slice(1)).get("token");
          assert.ok(secret);
          token = secret;
        } else {
          token = randomBytes(32).toString("base64url");
          await db.admin.query(
            "insert into auth_password_reset_tokens(auth_identity_id,token_hash,requested_email,expires_at) values($1,$2,$3,now()+interval '1 hour')",
            [identity, hashOpaqueToken(token), email],
          );
        }
        const exchange = await exchangePasswordResetToken(token, new Request(origin + "/reset-password"));
        assert.ok(exchange);
        const confirmation = new Request(origin + "/reset-password", {
          method: "POST", headers: {
            cookie: passwordResetExchangeCookieName + "=" + exchange.cookieValue,
            origin, "sec-fetch-site": "same-origin",
          },
        });
        const formToken = createPasswordResetFormToken(confirmation.headers);
        assert.ok(formToken);
        return { exchange, confirmation, formToken };
      }
      const bound = await issueReset(true), global = await issueReset(false);
      assert.equal(await hasValidPasswordResetExchange(bound.confirmation.headers), true);
      const response = await patchWorkspaceAccess(request(`/api/settings/access/users?workspaceId=${workspaceId}`, "PATCH", { userId: viewerId, status: "suspended" }));
      assert.equal(response.status, 200, await response.clone().text());
      const rows = (await db.admin.query(
        "select u.id,u.status,i.credential_state from workspace_users u join auth_identities i on i.id=u.auth_identity_id where u.id=any($1::uuid[])",
        [[viewerId, otherUserId]],
      )).rows;
      assert.deepEqual(rows.find(row => row.id === viewerId), { id: viewerId, status: "suspended", credential_state: "active" });
      assert.deepEqual(rows.find(row => row.id === otherUserId), { id: otherUserId, status: "active", credential_state: "active" });
      const invalidated = (await db.admin.query(
        "select used_at is not null as used from auth_password_reset_exchanges where id=$1", [bound.exchange.exchangeId],
      )).rows[0];
      assert.equal(invalidated.used, true);
      // Legacy suspended memberships may still have an exchange that was not marked used.
      await db.admin.query("update auth_password_reset_exchanges set used_at=null where id=$1", [bound.exchange.exchangeId]);
      assert.equal(await hasValidPasswordResetExchange(bound.confirmation.headers), false);
      const password = randomBytes(32).toString("base64url");
      assert.equal((await confirmPasswordReset({
        password, confirmation: password, formToken: bound.formToken, request: bound.confirmation,
      })).status, "invalid_token");
      assert.equal((await db.admin.query("select password_hash from auth_identities where id=$1", [identity])).rows[0].password_hash, null);
      assert.equal(await hasValidPasswordResetExchange(global.confirmation.headers), true);
      assert.equal((await confirmPasswordReset({
        password, confirmation: password, formToken: global.formToken, request: global.confirmation,
      })).status, "ok");
    });

    await t.test("both access endpoints refuse a downgrade used to suspend a higher-privilege member", async () => {
      const adminId = randomUUID(), customerOwnerId = randomUUID(), secondOwnerId = randomUUID(), platformOwnerId = randomUUID();
      for (const [id, ws, role, productRole] of [
        [adminId, workspaceId, "admin", "workspace_admin"],
        [customerOwnerId, workspaceId, "owner", "customer_owner"],
        [secondOwnerId, workspaceId, "owner", "customer_owner"],
        [platformOwnerId, fixture.workspaceId, "owner", "platform_admin"],
      ]) {
        await db.admin.query(
          "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC role boundary',$3,$4,$5,'active')",
          [id, ws, `synthetic-role-${id}@example.invalid`, role, productRole],
        );
      }
      const identity = (await db.admin.query("select auth_identity_id from workspace_users where id=$1", [adminId])).rows[0].auth_identity_id;
      await db.admin.query("update auth_identities set credential_state='active',mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [identity]);
      const adminCookie = "v2." + randomBytes(32).toString("base64url");
      await db.admin.query(
        "insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",
        [randomUUID(), createHash("sha256").update(adminCookie).digest("hex"), identity, adminId, workspaceId],
      );
      const desired = { role: "assistant", productRole: "viewer", status: "suspended" };
      const accessPath = `/api/settings/access/users?workspaceId=${workspaceId}`;
      assert.equal((await patchWorkspaceAccess(request(accessPath, "PATCH", { ...desired, userId: customerOwnerId }, adminCookie))).status, 403);
      assert.equal((await patchCustomerAccess(request("/api/crm/customer-access", "PATCH", {
        ...desired, operation: "workspace_user", userId: platformOwnerId,
      }))).status, 403);
      const rows = (await db.admin.query(
        "select id,role,product_role,status from workspace_users where id=any($1::uuid[])",
        [[customerOwnerId, platformOwnerId]],
      )).rows;
      assert.deepEqual(rows.find(row => row.id === customerOwnerId), { id: customerOwnerId, role: "owner", product_role: "customer_owner", status: "active" });
      assert.deepEqual(rows.find(row => row.id === platformOwnerId), { id: platformOwnerId, role: "owner", product_role: "platform_admin", status: "active" });
    });

    await t.test("Growth can read its fixed workspace but a similarly named internal workspace stays forbidden", async () => {
      const otherWorkspaceId = randomUUID();
      await db.admin.query(
        "insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'Novalure Growth','novalure_internal','novalure_internal',jsonb_build_object('workspaceKey','novalure-growth'))",
        [otherWorkspaceId],
      );
      async function growthScope(ws: string) {
        const id = randomUUID(), project = randomUUID();
        const identity = (await db.admin.query(
          "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Growth agent',$3,'agent','novalureGrowth','active') returning auth_identity_id",
          [id, ws, `synthetic-growth-${id}@example.invalid`],
        )).rows[0].auth_identity_id;
        await db.admin.query("update auth_identities set credential_state='active',mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [identity]);
        const value = "v2." + randomBytes(32).toString("base64url");
        await db.admin.query(
          "insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",
          [randomUUID(), createHash("sha256").update(value).digest("hex"), identity, id, ws],
        );
        await db.admin.query("insert into projects(id,workspace_id,name,type,status) values($1,$2,'SYNTHETIC Growth project','Bauträger','Aktiv')", [project, ws]);
        await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [ws, project, id]);
        return { project, request: new Request(origin + "/api/crm/core", { headers: { cookie: "novalure_session=" + value } }) };
      }
      const canonical = await growthScope(NOVALURE_GROWTH_WORKSPACE_ID), unrelated = await growthScope(otherWorkspaceId);
      const allowed = await getCrmCore(canonical.request);
      assert.equal(allowed.status, 200, await allowed.clone().text());
      const core = await allowed.json();
      assert.equal(core.activeWorkspaceId, NOVALURE_GROWTH_WORKSPACE_ID);
      assert.ok(core.data.projects.some((project: { id: string }) => project.id === canonical.project));
      assert.ok(!core.data.projects.some((project: { id: string }) => project.id === unrelated.project));
      const denied = await getCrmCore(unrelated.request);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "DATA_SCOPE_DENIED");
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
