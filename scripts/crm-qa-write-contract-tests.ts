import assert from'node:assert/strict';import{describe,it}from'node:test';import{CRM_QA_WRITE_CONTRACT_VERSION}from'../src/lib/crm-qa-write-contract';
describe('EVM-08C CRM QA write contract',()=>{
 it('uses an isolated version and exact scope',()=>{assert.equal(CRM_QA_WRITE_CONTRACT_VERSION,'crm-qa-write-v1');});
 it('migration permits only synthetic activity content and neutralized cleanup',async()=>{const sql=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../migrations/089_evm08c_qa_activity_contract.sql',import.meta.url),'utf8'));assert.match(sql,/crm\.qa\.activity\.write/);assert.match(sql,/SYNTHETIC: CLEANED EVM-08C QA activity/);assert.doesNotMatch(sql,/grant .*delete/i);});
});
