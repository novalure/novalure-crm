import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalSalesPool } from './local-sales-db.mjs';

/** Exact additive schema in an owned loopback fixture; normal login/MFA and provider closure remain intact. */
export async function seedWebsiteSalesAdvisoryBrowser(db, account) {
  assert.equal(db.fixtureMode, 'design-c-current-application-originals');
  assert.equal(db.database, 'neondb');
  assert(/^sales_qa_[a-f0-9]+$/.test(db.role));
  assert(path.resolve(db.directory).startsWith(path.resolve('.npm-cache/qa') + path.sep));
  assert(account.websiteSales?.syntheticOnly && account.websiteStudio?.operations && account.websiteCommerce?.syntheticOnly);
  assert.equal(account.workspaceId, '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101');
  const extension = JSON.parse(await readFile('config/crm-candidate-fresh-website-sales-extension.json', 'utf8'));
  assert.equal(extension.id, 'WEBSITE_SALES_ADVISORY_210');
  assert.equal(extension.forward.length, 9);
  const filename = '210_website_sales_advisory.sql', version = filename.slice(0, -4);
  const pinned = extension.forward.find(row => row.path === `migrations/${filename}`);
  assert(pinned && pinned.manual === false);
  const sql = await readFile(path.resolve('migrations', filename), 'utf8');
  const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(checksum, pinned.sha256, 'Advisory browser fixture requires its final reviewed SQL pin');
  const owner = new LocalSalesPool({ host: '127.0.0.1', port: db.port, database: db.database, user: 'neondb_owner' });
  const connection = await owner.connect();
  try {
    const actor = (await connection.query('select current_user as actor,rolsuper from pg_roles where rolname=current_user')).rows[0];
    assert.deepEqual(actor, { actor: 'neondb_owner', rolsuper: false });
    for (const prior of extension.forward.slice(0, -1)) {
      const predecessor = prior.path.split('/').at(-1).slice(0, -4);
      const recorded = (await connection.query('select checksum from novalure_schema_migrations where version=$1', [predecessor])).rows[0];
      assert.equal(recorded?.checksum, prior.sha256, `Exact predecessor required: ${predecessor}`);
    }
    const existing = (await connection.query('select checksum from novalure_schema_migrations where version=$1', [version])).rows[0];
    if (existing) assert.equal(existing.checksum, checksum, 'Existing advisory schema must match the exact source');
    else {
      await connection.query('begin');
      await connection.query(sql);
      await connection.query('insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)', [version, filename.slice(4, -4), checksum]);
      await connection.query('commit');
    }
    const roles = (await connection.query("select rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname in('novalure_website_sales_advisory_access_owner','novalure_website_sales_advisory_executor') order by rolname")).rows;
    assert.equal(roles.length, 2);
    assert(roles.every(role => !role.rolcanlogin && !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb));
    for (const role of roles) assert.equal((await connection.query('select pg_has_role($1,$2,\'MEMBER\') as member', [db.role, role.rolname])).rows[0].member, false);
    const tables = (await connection.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'crm_website_sales_advisory%' order by c.relname")).rows;
    assert(tables.length >= 5 && tables.every(table => table.relrowsecurity && table.relforcerowsecurity));
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally { connection.release(); await owner.end(); }
  return { websiteAdvisory: { syntheticOnly: true, migration: { file: filename, checksum },
    nativeLoginMfaRequired: true, liveProviderConfiguration: false, activeModelConfiguration: false } };
}
