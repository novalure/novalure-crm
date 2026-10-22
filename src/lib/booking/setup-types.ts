import type { BookingKind, BookingRules } from "./types";

export type BookingLocation = {
  id: string;
  label: string;
  address: string;
  confirmed: boolean;
};
export type BookingTravelSettings = {
  enabled: boolean;
  startLocationId: string | null;
  endLocationId: string | null;
  onlineLocationId: string | null;
  additionalBufferMinutes: number;
  directTravel: boolean;
  returnToEndLocation: boolean;
  maxDriveMinutes: number | null;
  locations: BookingLocation[];
};

export const defaultBookingTravelSettings: BookingTravelSettings = {
  enabled: false,
  startLocationId: null,
  endLocationId: null,
  onlineLocationId: null,
  additionalBufferMinutes: 15,
  directTravel: true,
  returnToEndLocation: false,
  maxDriveMinutes: null,
  locations: [],
};

export type BookingSetupScope = "company" | "employee";
export type BookingSetupKind = "*" | BookingKind;
export type BookingSetupSection = "rules" | "travel" | "communication";

export type BookingSetupLayer = {
  scope: BookingSetupScope;
  kind: BookingSetupKind;
  rules: Partial<BookingRules>;
  travel: Partial<BookingTravelSettings>;
  communication: Record<string, unknown>;
  companyResets: Partial<Record<BookingSetupSection, string[]>>;
  revision: number;
};
