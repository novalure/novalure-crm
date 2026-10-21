import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { readAccountLanguagePreference, saveAccountLanguagePreference } from "../src/lib/db/language-preference-repository";
import { withTenantTransaction, type TenantPool, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { seedDesignCIntegration, startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

function personalSession(input: { userId: string; workspaceId: string; authIdentityId: string }): AppSession {
  return {
    ...input, authenticated: true, source: "database", workspaceName: "SYNTHETIC UI LANGUAGE",
    name: "SYNTHETIC viewer", email: "synthetic-language@example.invalid", role: "assistant", productRole: "viewer",
    permissions: getRolePermissions("assistant"), productPermissions: getProductRoleCapabilities("viewer"),
  };
}

test("synthetic forced-RLS account preference survives new sessions/workspaces and isolates other identities", { timeout: 240000 }, async () => {
  const db = await startDesignCIntegrationDatabase();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as TenantPool };
  try {
    const fixture = await seedDesignCIntegration({ ...db, languagePreference: "auto" });
    const viewer = personalSession(fixture.viewer);
    const customer = personalSession(fixture.customer);
    await db.admin.query("delete from account_ui_preferences where auth_identity_id=$1", [viewer.authIdentityId]);
    const secondWorkspaceId = randomUUID(), secondMembershipId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC second language workspace','self_service_customer','property_developer')", [secondWorkspaceId]);
    await db.admin.query(
      "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC same language identity',$3,'assistant','viewer','active')",
      [secondMembershipId, secondWorkspaceId, fixture.viewer.email],
    );
    const second = personalSession({ userId: secondMembershipId, workspaceId: secondWorkspaceId, authIdentityId: viewer.authIdentityId! });

    assert.equal(await readAccountLanguagePreference(viewer, options), "auto", "missing row is automatic, with no write-on-read");
    assert.equal(await saveAccountLanguagePreference(viewer, "en", options), "en", "a regular viewer can save their own choice");
    assert.equal(await readAccountLanguagePreference({ ...viewer }, options), "en", "new server session/device reads the identity preference");
    assert.equal(await readAccountLanguagePreference(second, options), "en", "another membership of the same identity shares the choice");
    assert.equal(await readAccountLanguagePreference(customer, options), "auto", "another user in the same workspace is unaffected");
    await saveAccountLanguagePreference(second, "de", options);
    assert.equal(await readAccountLanguagePreference(viewer, options), "de");

    const scope = { actorId: viewer.userId, workspaceId: viewer.workspaceId };
    await withTenantTransaction(scope, async tx => {
      assert.equal((await tx.query("select language_preference from account_ui_preferences where auth_identity_id=$1", [customer.authIdentityId])).length, 0);
      await assert.rejects(tx.execute("insert into account_ui_preferences(auth_identity_id,language_preference) values($1,'de')", [customer.authIdentityId]), (error: unknown) => (error as { code?: string }).code === "42501");
    }, options).then(() => assert.fail("an RLS-rejected transaction must not report a commit"), () => undefined);
    await assert.rejects(saveAccountLanguagePreference({ ...viewer, authIdentityId: customer.authIdentityId }, "de", options), "a forged different identity is rejected by database RLS");
    await assert.rejects(saveAccountLanguagePreference({ ...viewer, workspaceId: secondWorkspaceId }, "de", options), "actor from another tenant cannot save even their own identity");
    await assert.rejects(saveAccountLanguagePreference({ ...viewer, authIdentityId: undefined }, "de", options));

    await saveAccountLanguagePreference(viewer, "auto", options);
    assert.equal(await readAccountLanguagePreference(second, options), "auto", "explicit reset stores mode instead of the resolved geo language");
    const stored = await db.admin.query("select language_preference from account_ui_preferences where auth_identity_id=$1", [viewer.authIdentityId]);
    assert.equal(stored.rows[0].language_preference, "auto");
    const audit = await db.admin.query("select metadata from auth_audit_events where event_type='auth.language_preference.updated' and auth_identity_id=$1 order by occurred_at desc", [viewer.authIdentityId]);
    assert.equal(audit.rows.length, 3, "each successful language save has an atomic audit receipt");
    assert.ok(audit.rows.every((row: { metadata: object }) => Object.keys(row.metadata).join() === "preference"));

    await db.admin.query("update workspace_users set status='invited' where id=$1", [viewer.userId]);
    await assert.rejects(saveAccountLanguagePreference(viewer, "en", options), "non-active memberships cannot write");
    assert.equal(await readAccountLanguagePreference(second, options), "auto", "failed writes never become success on another device");
  } finally {
    await db.stop();
  }
});
