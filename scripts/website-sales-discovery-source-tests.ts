import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { discoveryQuotedFact, discoveryQuotedDomain, discoveryQuotedEmail, websiteSalesDiscoveryCandidateSchema } from "../src/lib/website-sales-discovery";

test("reviewed identity quotes require complete words, hostnames and mailbox tokens",()=>{
  assert.equal(discoveryQuotedFact("Sourced Café Company at 11 King Street, Dublin", "1 King Street"),false);
  assert.equal(discoveryQuotedFact("Sourced Café Company at 1 King Street, Dublin", "1 King Street"),true);
  assert.equal(discoveryQuotedFact("Unrelated NotSourced Company", "Sourced Company"),false);
  assert.equal(discoveryQuotedFact("Source: SYNTHETIC CAFÉ COMPANY.", "Synthetic Café Company"),true);
  assert.equal(discoveryQuotedDomain("Website: not-evil.example.com", "evil.example"),false);
  assert.equal(discoveryQuotedDomain("Email: contact@evil.example", "evil.example"),false);
  assert.equal(discoveryQuotedDomain("Website: evil.exampleé.com", "evil.example"),false);
  assert.equal(discoveryQuotedDomain("Website: https://other.example/path/evil.example", "evil.example"),false);
  assert.equal(discoveryQuotedDomain("Website: other.example?target=evil.example", "evil.example"),false);
  assert.equal(discoveryQuotedDomain("Website: https://evil.example/contact", "evil.example"),true);
  assert.equal(discoveryQuotedDomain("Website: evil.example.", "evil.example"),true);
  assert.equal(discoveryQuotedEmail("not-public@example.invalid", "public@example.invalid"),false);
  assert.equal(discoveryQuotedEmail("public@example.invalid.com", "public@example.invalid"),false);
  assert.equal(discoveryQuotedEmail("public@example.invalidé.com", "public@example.invalid"),false);
  assert.equal(discoveryQuotedEmail("Contact: PUBLIC@example.invalid.", "public@example.invalid"),true);
});
test("CRM request schema rejects house-number, hostname, mailbox and phone prefix substitutions",()=>{
  const candidate={candidateId:randomUUID(),countryCode:"IE",companyName:"Sourced Company",locationLabel:"1 King Street, Dublin",address:"1 King Street, Dublin",domain:"evil.example",
    contacts:[{name:"Public Contact",email:"public@example.invalid",phone:"353 12",sourceReferenceId:"source"}],sourceReferences:[{sourceId:"source",sourceUrl:"https://source.example/company",contentDigest:"a".repeat(64),
      quote:"Sourced Company at 1 King Street, Dublin. Website evil.example. Public Contact: public@example.invalid. Phone 353 12.",observedAt:"2026-01-01T00:00:00Z",validUntil:"2026-01-02T00:00:00Z"}]};
  assert.equal(websiteSalesDiscoveryCandidateSchema.safeParse(candidate).success,true);
  for(const replacement of [["1 King Street","11 King Street"],["Website evil.example.","Website not-evil.example.com."],["public@example.invalid.","not-public@example.invalid."],["Phone 353 12.","Phone 353 123."]]){
    const forged=structuredClone(candidate);forged.sourceReferences[0]!.quote=forged.sourceReferences[0]!.quote.replace(replacement[0]!,replacement[1]!);assert.equal(websiteSalesDiscoveryCandidateSchema.safeParse(forged).success,false);
  }
});
