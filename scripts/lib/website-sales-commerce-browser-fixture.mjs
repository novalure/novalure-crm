import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalSalesPool } from './local-sales-db.mjs';

/** Installs the unchanged commerce schema only in an owned disposable loopback cluster. */
export async function seedWebsiteSalesCommerceBrowser(db, account) {
  assert.equal(db.fixtureMode, 'design-c-current-application-originals');
  assert.equal(db.database, 'neondb');
  assert(/^sales_qa_[a-f0-9]+$/.test(db.role));
  assert(path.resolve(db.directory).startsWith(path.resolve('.npm-cache/qa') + path.sep));
  assert(account.websiteSales?.syntheticOnly && account.websiteStudio?.operations);
  const filename = '209_website_sales_commerce.sql', version = filename.slice(0, -4);
  const sql = await readFile(path.resolve('migrations', filename), 'utf8');
  const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
  const owner = new LocalSalesPool({ host: '127.0.0.1', port: db.port, database: db.database, user: 'neondb_owner' });
  const connection = await owner.connect();
  try {
    const identity = (await connection.query('select current_user as actor,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
    assert.deepEqual(identity, { actor: 'neondb_owner', rolsuper: false, rolbypassrls: true });
    const existing = (await connection.query('select checksum from novalure_schema_migrations where version=$1', [version])).rows[0];
    if (existing) assert.equal(existing.checksum, checksum, 'Local commerce schema must match the exact source file');
    else {
      await connection.query('begin');
      await connection.query(sql);
      await connection.query('insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)', [version, filename.slice(4, -4), checksum]);
      await connection.query('commit');
    }
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally { connection.release(); await owner.end(); }
  return { websiteCommerce: { syntheticOnly: true, migration: { file: filename, checksum }, liveProviderConfiguration: false } };
}
