import type { LeadMatchProfile, LeadMatchReason } from "./lead-qualification-matching";
import type {LeadProfileCompleteness} from './lead-qualification-plan';
export const leadProofMaxUploadBytes = 4 * 1024 * 1024;
export type LeadProofKind = "financing_confirmation" | "funds_evidence" | "other";
export type LeadProofStatus = "pending" | "accepted" | "rejected" | "revoked";
export type LeadQualificationProof = { id: string; kind: LeadProofKind; purpose: string; fileName: string; status: LeadProofStatus; uploadedAt: string; usableUntil: string; reviewReason: string | null; version: number; available: boolean; downloadUrl: string };
export type LeadPropertyMatch = { id: string; propertyId: string; propertyTitle: string; score: number; coverage: number; eligible: boolean; fresh: boolean; reasons: LeadMatchReason[]; computedAt: string };
export type LeadQualificationState = { leadId: string; projectId: string; leadTitle: string; qualified: boolean; profile: LeadMatchProfile;profileRevision:string;completeness:LeadProfileCompleteness; proofs: LeadQualificationProof[]; matches: LeadPropertyMatch[]; refreshPending: boolean };
