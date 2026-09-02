#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildClosingPdf } from "../src/lib/broker-flow/closing-export.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repositoryRoot, "output/pdf/novalure-closing-commission-report-qa-sample.pdf");
const sample = [{
  baseAmountMinor: "50000000",
  buyerCommissionMinor: "1800000",
  closingDate: "2026-09-02",
  commissionSplits: [
    { allocationType: "percentage", basisPoints: 7_500, side: "buyer", userId: "11111111-1111-4111-8111-111111111111" },
    { allocationType: "percentage", basisPoints: 2_500, side: "referral", sourceSide: "buyer", userId: "22222222-2222-4222-8222-222222222222" },
    { allocationType: "percentage", basisPoints: 10_000, side: "seller", userId: "33333333-3333-4333-8333-333333333333" },
  ],
  contractDate: "2026-09-01",
  contractType: "purchase",
  currency: "EUR",
  grossCommissionMinor: "3600000",
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  netCommissionMinor: "3000000",
  paymentStatus: "open",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sellerCommissionMinor: "1800000",
  status: "reviewed",
  taxMinor: "600000",
}];

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.from(buildClosingPdf(sample, new Date("2026-09-02T12:00:00.000Z"))));
console.log(outputPath);
