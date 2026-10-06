/** Client-safe contract. Only the server builds document content from saved, scoped records. */
export type PropertyExposeSource = "generated" | "uploaded";
export type PropertyExposeLanguage = "de" | "en";
export type PropertyExposeOptions = {
  template: "compact" | "full";
  language: PropertyExposeLanguage;
  address: "city" | "full" | "hidden";
  showPrice: boolean;
  showContact: boolean;
  imageIds: string[];
  floorPlanIds: string[];
  title?: string;
  description?: string;
};
export type PropertyExposeVersion = {
  id: string;
  source: PropertyExposeSource;
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  pageCount: number;
  versionLabel: string;
  sourceFingerprint: string;
  stale: boolean;
  available: boolean;
  previewUrl: string;
  downloadUrl: string;
  options?: PropertyExposeOptions;
};
export type PropertyExposeMediaChoice = {
  id: string;
  title: string;
  url: string;
  kind: "image" | "floorplan";
  isCover: boolean;
  mimeType?: string;
};
export type PropertyExposeState = {
  propertyId: string;
  propertyTitle: string;
  revision: string;
  sourceFingerprint: string;
  preferredSource: PropertyExposeSource;
  activeDocumentId: string | null;
  versions: PropertyExposeVersion[];
  media: PropertyExposeMediaChoice[];
  defaultOptions: PropertyExposeOptions;
  warnings: string[];
  canEdit: boolean;
};
export type PropertyExposeResponse = {
  persisted: boolean;
  data?: PropertyExposeState;
  /** Newly created draft; activation remains an explicit, separate operation. */
  documentId?: string;
  error?: string;
  code?: string;
};
export type PropertyExposeFact = { label: string; value: string };
export type PropertyExposeSection = { heading: string; text: string };
export type PropertyExposeImage = {
  id: string;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  caption: string;
  kind: "image" | "floorplan";
};
/** No arbitrary URLs, HTML, internal notes or unfiltered database objects. */
export type PropertyExposeDocument = {
  template: "compact" | "full";
  language: PropertyExposeLanguage;
  title: string;
  reference: string;
  createdAt: string;
  address?: string;
  price?: string;
  facts: PropertyExposeFact[];
  sections: PropertyExposeSection[];
  costs: PropertyExposeFact[];
  energy: PropertyExposeFact[];
  contact?: { name?: string; email?: string; phone?: string; company?: string };
  images: PropertyExposeImage[];
  floorPlanPdfs?: { id: string; bytes: Uint8Array; caption: string; pageCount: number }[];
  notices: string[];
};

export const PROPERTY_EXPOSE_MAX_PDF_BYTES = 10 * 1024 * 1024;
export const PROPERTY_EXPOSE_MAX_IMAGES = 20;
export const PROPERTY_EXPOSE_MAX_FLOORPLANS = 8;
