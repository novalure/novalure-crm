import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {assertPackage4MigrationSources} from './lib/shared-learning-package4-migration.mjs';
import {isManualCutoverVersion,createMigrationPlan} from './db-migrate.mjs';
test('Package4 numbered migration matches reserved source contract and actual119 catalog receipt',()=>{
 const contract=assertPackage4MigrationSources();
 const receipt=JSON.parse(readFileSync('qa/shared-learning-package4-2026-11-02/production-catalog-readonly.json','utf8')).metadata;
 const publisher=JSON.parse(readFileSync('qa/shared-learning-package4-2026-11-02/publisher-catalog-readonly.json','utf8')).metadata;
 assert.equal(receipt.project,contract.projectId);assert.equal(receipt.branch,contract.branchId);assert.equal(receipt.database,contract.database);
 assert.equal(receipt.ledger.find(row=>row.version===contract.requiredPredecessor).checksum,contract.predecessorChecksum);
 assert.equal(receipt.package4Exists,false);assert.equal(publisher.maxMigrationNumber,119);
 assert.equal(isManualCutoverVersion(contract.version),true);
 assert.throws(()=>createMigrationPlan({command:'up',only:contract.version,appliedVersions:[]}));
});
