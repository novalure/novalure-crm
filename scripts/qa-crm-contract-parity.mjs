import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCrmContractRequest } from "../src/lib/crm-service-contract.ts";
const root=process.argv[2];if(!root)throw new Error("Usage: node --import tsx scripts/qa-crm-contract-parity.mjs <read-only Evelyn checkout>");
const revision="8119798a97347eb1c96126c6a14308e158e20862";
const sources=["src/connectors/crm/contract.ts","src/connectors/crm/mapping.ts","src/domain/types.ts","src/security/redaction.ts"];
const hashes={};
for(const relative of sources) {
 const current=await readFile(path.join(root,relative),"utf8");
 const pinned=execFileSync("git",["-C",root,"show",revision+":"+relative],{encoding:"utf8"});
 assert.equal(current.replaceAll("\r\n","\n"),pinned.replaceAll("\r\n","\n"),relative+" differs from pin");
 hashes[relative]=createHash("sha256").update(pinned.replaceAll("\r\n","\n")).digest("hex");
}
const {crmRequestSchema}=await import(pathToFileURL(path.join(root,sources[0])).href);
const base={contractVersion:"crm-integration-v1",environment:"simulation",synthetic:true,operation:"Read",entity:"Contact",tenantId:"sim-tenant",resourceId:"sim-resource",actorId:"sales",correlationId:"sim-correlation",idempotencyKey:"sim-idempotency",expectedVersion:null,approvalReference:null,auditReference:"sim-audit",validation:{status:"VALIDATED",schemaVersion:"crm-integration-v1"},patch:{}};
const vectors=[];
const add=(label,request)=>vectors.push({label,request,accepted:crmRequestSchema.safeParse(request).success});
for(const operation of ["Read","Update","PrepareOffer","PrepareReservation","SendOffer","ConfirmReservation","ConfirmSale"])
 for(const entity of ["Contact","Company","Developer","Project","Unit","BuyerLead","Qualification","Offer","Task","Appointment","Viewing","Reservation","Sale","Communication","ApprovalReference"])
  add(operation+"/"+entity,{...base,operation,entity,expectedVersion:operation==="Read"?null:1,approvalReference:operation==="Read"?null:"sim-approval"});
for(const field of Object.keys(base)){const request={...base};delete request[field];add("missing:"+field,request);}
for(const [field,value]of [["contractVersion","v2"],["environment","production"],["synthetic",false],["operation","Delete"],["entity","Invoice"],["tenantId","native-uuid"],["actorId","owner"],["resourceId","sim-"],["correlationId",13],["idempotencyKey",null],["expectedVersion",0],["expectedVersion",-1],["expectedVersion",1.5],["approvalReference","real-approval"],["auditReference",""],["validation",{}],["validation",{status:"VALIDATED",schemaVersion:"crm-integration-v1",owner:true}],["patch",{email:"SYNTHETIC: User"}]])add("invalid:"+field+":"+JSON.stringify(value),{...base,[field]:value});
for(const value of ["SYNTHETIC: Good name","Real name","SYNTHETIC: passwordvalue","SYNTHETIC: passwd","SYNTHETIC: secretvalue","SYNTHETIC: tokenvalue","SYNTHETIC: api_key","SYNTHETIC: credential","SYNTHETIC: private-key","SYNTHETIC: canary","SYNTHETIC: sk-a","SYNTHETIC: ghp_value","SYNTHETIC: github_pat_value","SYNTHETIC: AKIA","SYNTHETIC: bearer value","SYNTHETIC: a@b","SYNTHETIC: https://invalid.example","SYNTHETIC: "+ "x".repeat(101)])add("patch:"+value,{...base,operation:"Update",expectedVersion:1,patch:{name:value}});
add("unknown-root",{...base,owner:true});add("read-patch",{...base,patch:{name:"SYNTHETIC: Name"}});add("null-update-version",{...base,operation:"Update"});
for(const [label,value]of [["null-root",null],["array-root",[]],["string-root","invalid"],["read-version",{...base,expectedVersion:1}],["unsafe-large-version",{...base,expectedVersion:Number.MAX_SAFE_INTEGER+1}],["uppercase-id",{...base,resourceId:"sim-UPPER"}],["invalid-validation",{...base,validation:{status:"UNVERIFIED",schemaVersion:"crm-integration-v1"}}]])add(label,value);
for(const vector of vectors){let accepted=true;try{parseCrmContractRequest(vector.request);}catch{accepted=false;}assert.equal(accepted,vector.accepted,vector.label);}
await mkdir("scripts/fixtures",{recursive:true});
await writeFile("scripts/fixtures/crm-v1-request-parity.json",JSON.stringify({sourceRevision:revision,sourceHashes:hashes,vectors},null,2)+"\n");
console.log(JSON.stringify({sourceRevision:revision,checked:vectors.length,mismatches:0,artifact:"scripts/fixtures/crm-v1-request-parity.json"}));
