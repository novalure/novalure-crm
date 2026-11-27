import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
export function assertPackage4MigrationSources(cwd=resolve(import.meta.dirname,'../..')) {
 const contract=JSON.parse(readFileSync(resolve(cwd,'config/shared-learning-package4-migration.json'),'utf8'));
 assert.equal(contract.schemaVersion,'shared-learning-package4-migration-v1');
 assert.equal(contract.rolloutMode,'MANUAL_EXACT_REVISION_ONLY');
 assert.equal(contract.version,'120_shared_behavior_package4');
 assert.equal(contract.requiredPredecessor,'119_shared_behavior_revocable_operation');
 assert.deepEqual(readdirSync(resolve(cwd,'migrations')).filter(name=>name.startsWith('120_')),['120_shared_behavior_package4.sql']);
 const hash=path=>createHash('sha256').update(readFileSync(resolve(cwd,path),'utf8').replace(/\r\n/g,'\n')).digest('hex');
 assert.equal(hash('migrations/119_shared_behavior_revocable_operation.sql'),contract.predecessorChecksum);
 assert.equal(hash('migrations/120_shared_behavior_package4.sql'),contract.sqlChecksum);
 assert.equal(hash('migrations/staged/shared_behavior_package4.sql'),contract.sqlChecksum);
 return contract;
}
