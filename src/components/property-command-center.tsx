"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  BrokerMandate,
  BuyerSearchProfile,
  Contact,
  Lead,
  Project,
  PropertyBuilding,
  PropertyCostItem,
  PropertyDocumentItem,
  PropertyMediaItem,
  PropertyPriceVisibility,
  PropertyReservation,
  PropertyTextBlock,
  PropertyUnit,
  SellerListing,
  WorkspaceRole,
} from "@/lib/crm-types";
import {
  buildPropertyAssets,
  buildPropertyDataQualityIssues,
  buildPropertyMatches,
  getPropertyActionStates,
  PROPERTY_CHANNEL_TYPES,
  PROPERTY_CHANNEL_PRICE_KEYS,
  PROPERTY_COST_GROUPS,
  PROPERTY_COST_TEMPLATES,
  PROPERTY_DEPARTMENT_TABS,
  PROPERTY_DOCUMENT_CATEGORIES,
  PROPERTY_FIELD_SECTIONS,
  PROPERTY_MEDIA_CATEGORIES,
  PROPERTY_PRICE_VISIBILITY_OPTIONS,
  PROPERTY_TEXT_FIELDS,
  routePropertyInquiry,
  runPropertyChannelPreflight,
  type PropertyActionState,
  type PropertyAssetStatus,
  type PropertyDepartmentTabId,
} from "@/lib/property-department";
import type { ProductRole, WorkspaceProductContext } from "@/lib/product-model";
import { formatCurrency, formatNumber, getLocale, type LanguageCode } from "@/lib/i18n";

type PropertyCommandCenterProps = {
  brokerMandates: BrokerMandate[];
  buyerSearchProfiles: BuyerSearchProfile[];
  buildings: PropertyBuilding[];
  contacts: Contact[];
  context: WorkspaceProductContext;
  language: LanguageCode;
  leads: Lead[];
  onOpenLeadInbox: () => void;
  onOpenReservations: () => void;
  onOpenUnits: () => void;
  onPropertyChanged?: () => Promise<void> | void;
  projectLabel: string;
  projects: Project[];
  propertyCostItems: PropertyCostItem[];
  propertyDocuments: PropertyDocumentItem[];
  propertyMedia: PropertyMediaItem[];
  propertyTextBlocks: PropertyTextBlock[];
  reservations: PropertyReservation[];
  sellerListings: SellerListing[];
  sessionProductRole: ProductRole;
  sessionRole: WorkspaceRole;
  units: PropertyUnit[];
};

type PropertyDraft = {
  address: string;
  areaSqm: string;
  availableFrom: string;
  availableFromText: string;
  availabilityNote: string;
  channelPriceVisibility: Record<string, PropertyPriceVisibility>;
  contactEmail: string;
  contactName: string;
  contactPhone: string;
  costItems: PropertyCostDraft[];
  fieldValues: Record<string, string>;
  gdprStatus: string;
  internalReference: string;
  marketingType: string;
  monthlyCostsGross: string;
  objectType: string;
  objectNumber: string;
  portalMappingStatus: string;
  postalCode: string;
  price: string;
  priceVisibility: PropertyPriceVisibility;
  projectId: string;
  publicPrice: string;
  purchaseAncillaryCosts: string;
  region: string;
  rentNet: string;
  rentPrice: string;
  rooms: string;
  subObjectType: string;
  textBlocks: Record<string, string>;
  title: string;
  usageType: string;
  yearBuilt: string;
};

type PropertyCostDraft = {
  costKey: string;
  groupKey: string;
  label: string;
  monthlyGross: string;
  monthlyNet: string;
  monthlyVat: string;
  oneTimeGross: string;
  oneTimeNet: string;
  oneTimeVat: string;
  exposeVisible: boolean;
};

const statusStyles: Record<PropertyAssetStatus, string> = {
  draft: "border-stone-300 bg-stone-50 text-stone-700",
  needs_review: "border-amber-200 bg-amber-50 text-amber-900",
  published: "border-emerald-200 bg-emerald-50 text-emerald-900",
  ready: "border-blue-200 bg-blue-50 text-blue-900",
  reserved: "border-violet-200 bg-violet-50 text-violet-900",
  sold: "border-slate-300 bg-slate-100 text-slate-800",
};

const statusLabels: Record<PropertyAssetStatus, string> = {
  draft: "Entwurf",
  needs_review: "Prüfen",
  published: "Veröffentlicht",
  ready: "Bereit",
  reserved: "Reserviert",
  sold: "Verkauft",
};

function StatusChip({ status }: { status: PropertyAssetStatus }) {
  return (
    <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${statusStyles[status]}`}>
      {statusLabels[status]}
    </span>
  );
}

function ActionButton({
  action,
  onClick,
}: {
  action: PropertyActionState;
  onClick?: () => void;
}) {
  return (
    <div className="min-w-0">
      <button
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-left text-xs font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!action.enabled}
        onClick={onClick}
        title={action.reason}
        type="button"
      >
        {action.label}
      </button>
      {!action.enabled && action.reason ? (
        <p className="mt-1 break-words text-[11px] leading-4 text-stone-500">{action.reason}</p>
      ) : null}
    </div>
  );
}

function fieldKey(sectionId: string, label: string) {
  return `${sectionId}.${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function parseMoney(value: string | undefined) {
  if (!value) return undefined;
  const multiplier = value.toLowerCase().includes("mio") ? 1_000_000 : 1;
  const parsed = Number(value.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed * multiplier : undefined;
}

function getBudgetRange(lead: Lead) {
  if (lead.buyerProfile) return { from: lead.buyerProfile.budgetFrom, to: lead.buyerProfile.budgetTo };
  if (lead.investorProfile) {
    return {
      from: lead.investorProfile.investmentVolumeFrom,
      to: lead.investorProfile.investmentVolumeTo,
    };
  }
  const money = parseMoney(lead.budget);
  return money ? { from: undefined, to: money } : {};
}

function formatDate(value: string | undefined, language: LanguageCode) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocale(language), { dateStyle: "medium" }).format(date);
}

function daysUntil(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function createCostDrafts(): PropertyCostDraft[] {
  return PROPERTY_COST_TEMPLATES.map((template) => ({
    costKey: template.key,
    exposeVisible: true,
    groupKey: template.groupKey,
    label: template.label,
    monthlyGross: "",
    monthlyNet: "",
    monthlyVat: "",
    oneTimeGross: "",
    oneTimeNet: "",
    oneTimeVat: "",
  }));
}

function createTextDrafts() {
  return Object.fromEntries(PROPERTY_TEXT_FIELDS.map((field) => [field.key, ""]));
}

function createChannelPriceDrafts() {
  return Object.fromEntries(PROPERTY_CHANNEL_PRICE_KEYS.map((channel) => [channel, "publish_price" as PropertyPriceVisibility]));
}

const propertyPanelClass = "rounded-lg border border-stone-200 bg-white p-5";
const propertyFieldClass = "grid min-w-0 gap-2 text-sm font-semibold text-slate-700";
const propertyInputClass = "min-h-12 w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-base font-medium leading-6 text-slate-950 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";
const propertySelectClass = `${propertyInputClass} pr-9`;
const propertyTextareaClass = `${propertyInputClass} min-h-[168px] resize-y align-top`;
const defaultOpenPropertyDetailSections = new Set(["location", "areas", "costs", "energy"]);

function PropertyFormSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <fieldset className={propertyPanelClass}>
      <legend className="text-lg font-semibold text-slate-950">{title}</legend>
      {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </fieldset>
  );
}

function toTextBlocks(draft: PropertyDraft) {
  return PROPERTY_TEXT_FIELDS.map((field, index) => ({
    channel: field.channel,
    content: draft.textBlocks[field.key] ?? "",
    position: index,
    status: field.key === "internal" ? "approved" : "draft",
    textKey: field.key,
    title: field.label,
    visibility: field.key === "internal" ? "internal" : "public",
  }));
}

function hasCostValue(item: PropertyCostDraft) {
  return [item.monthlyNet, item.monthlyVat, item.monthlyGross, item.oneTimeNet, item.oneTimeVat, item.oneTimeGross].some((value) => value.trim());
}

function toCostItems(draft: PropertyDraft) {
  return draft.costItems
    .filter((item) => hasCostValue(item))
    .map((item, index) => ({
      ...item,
      commissionRelevant: item.costKey.includes("commission"),
      position: index,
    }));
}

function listingIdFromAssetId(assetId: string | undefined) {
  return assetId?.startsWith("listing:") ? assetId.slice("listing:".length) : undefined;
}

export function PropertyCommandCenter({
  brokerMandates,
  buyerSearchProfiles,
  buildings,
  contacts,
  context,
  language,
  leads,
  onOpenLeadInbox,
  onOpenReservations,
  onOpenUnits,
  onPropertyChanged,
  projectLabel,
  projects,
  propertyCostItems,
  propertyDocuments,
  propertyMedia,
  propertyTextBlocks,
  reservations,
  sellerListings,
  sessionProductRole,
  sessionRole,
  units,
}: PropertyCommandCenterProps) {
  const assets = useMemo(
    () => buildPropertyAssets({
      brokerMandates,
      buildings,
      projects,
      propertyCostItems,
      propertyDocuments,
      propertyMedia,
      propertyTextBlocks,
      reservations,
      sellerListings,
      units,
    }),
    [brokerMandates, buildings, projects, propertyCostItems, propertyDocuments, propertyMedia, propertyTextBlocks, reservations, sellerListings, units],
  );
  const actions = useMemo(
    () => getPropertyActionStates({ productRole: sessionProductRole, technicalRole: sessionRole }),
    [sessionProductRole, sessionRole],
  );
  const [activeTab, setActiveTab] = useState<PropertyDepartmentTabId>("overview");
  const [statusFilter, setStatusFilter] = useState<PropertyAssetStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState(() => assets[0]?.id ?? "");
  const [selectedChannel, setSelectedChannel] = useState<(typeof PROPERTY_CHANNEL_TYPES)[number]>("Immobilienportal");
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [draft, setDraft] = useState<PropertyDraft>(() => ({
    address: "",
    areaSqm: "",
    availableFrom: "",
    availableFromText: "",
    availabilityNote: "",
    channelPriceVisibility: createChannelPriceDrafts(),
    contactEmail: "",
    contactName: "",
    contactPhone: "",
    costItems: createCostDrafts(),
    fieldValues: {},
    gdprStatus: "needs_review",
    internalReference: "",
    marketingType: "sale",
    monthlyCostsGross: "",
    objectType: "Wohnung",
    objectNumber: "",
    portalMappingStatus: "needs_review",
    postalCode: "",
    price: "",
    priceVisibility: "publish_price",
    projectId: projects[0]?.id ?? "",
    publicPrice: "",
    purchaseAncillaryCosts: "",
    region: "",
    rentNet: "",
    rentPrice: "",
    rooms: "",
    subObjectType: "",
    textBlocks: createTextDrafts(),
    title: "",
    usageType: "residential",
    yearBuilt: "",
  }));

  const filteredAssets = assets.filter((asset) => {
    const matchesStatus = statusFilter === "all" || asset.status === statusFilter;
    const needle = query.trim().toLowerCase();
    const matchesQuery =
      !needle ||
      [asset.title, asset.location, asset.objectType, asset.projectName].some((value) => value.toLowerCase().includes(needle));
    return matchesStatus && matchesQuery;
  });
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) ?? filteredAssets[0] ?? assets[0];
  const selectedListingId = listingIdFromAssetId(selectedAsset?.id);
  const selectedCostItems = selectedListingId ? propertyCostItems.filter((item) => item.propertyId === selectedListingId) : [];
  const selectedDocuments = selectedListingId ? propertyDocuments.filter((document) => document.propertyId === selectedListingId) : [];
  const selectedMedia = selectedListingId ? propertyMedia.filter((media) => media.propertyId === selectedListingId) : [];
  const selectedTextBlocks = selectedListingId ? propertyTextBlocks.filter((block) => block.propertyId === selectedListingId) : [];
  const preflight = selectedAsset ? runPropertyChannelPreflight(selectedAsset, selectedChannel) : null;
  const qualityIssues = buildPropertyDataQualityIssues({ assets, leads, reservations });
  const matches = buildPropertyMatches({ assets, buyerSearchProfiles, contacts, leads });
  const activeReservations = reservations.filter((reservation) => reservation.status === "hold" || reservation.status === "reserved");
  const routeResults = leads.slice(0, 20).map((lead) => {
    const budget = getBudgetRange(lead);
    return {
      lead,
      route: routePropertyInquiry({
        areaSqm: lead.areaSqm,
        budgetFrom: budget.from,
        budgetTo: budget.to,
        contactId: lead.contactId,
        leadId: lead.id,
        leadType: lead.type,
        location: lead.region,
        ownerUserId: lead.assignedToUserId,
        projectId: lead.projectId,
        rooms: lead.rooms,
        sourceChannel: lead.source,
        useCase: lead.buyerProfile?.useCase,
        workspaceId: lead.workspaceId,
      }, { assets, reservations, units }),
    };
  });
  const metrics = [
    ["Objekte", assets.length],
    ["Einheiten", units.length],
    ["Frei", units.filter((unit) => unit.status === "available").length],
    ["Reservierungen", activeReservations.length],
    ["Anfragen", leads.length],
    ["Datenhinweise", qualityIssues.length],
  ];
  const draftProjectName = projects.find((project) => project.id === draft.projectId)?.name ?? projectLabel;
  const draftPreflightItems = [
    { label: "Titel", ready: draft.title.trim().length > 0 },
    { label: "Adresse", ready: draft.address.trim().length > 0 },
    { label: "Projekt", ready: draft.projectId.trim().length > 0 },
    { label: "Preislogik", ready: Boolean(draft.priceVisibility) },
    { label: "DSGVO", ready: draft.gdprStatus === "ready" },
    { label: "Portal-Mapping", ready: draft.portalMappingStatus !== "needs_review" },
  ];
  const draftReadyCount = draftPreflightItems.filter((item) => item.ready).length;
  const nextDraftIssue = draftPreflightItems.find((item) => !item.ready)?.label ?? "Bereit für Freigabe";

  function updateDraft<Key extends keyof PropertyDraft>(key: Key, value: PropertyDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateField(sectionId: string, label: string, value: string) {
    const key = fieldKey(sectionId, label);
    setDraft((current) => ({
      ...current,
      fieldValues: { ...current.fieldValues, [key]: value },
    }));
  }

  function updateTextBlock(key: string, value: string) {
    setDraft((current) => ({
      ...current,
      textBlocks: { ...current.textBlocks, [key]: value },
    }));
  }

  function updateChannelPrice(channel: string, value: PropertyPriceVisibility) {
    setDraft((current) => ({
      ...current,
      channelPriceVisibility: { ...current.channelPriceVisibility, [channel]: value },
    }));
  }

  function updateCostItem(index: number, key: keyof PropertyCostDraft, value: string | boolean) {
    setDraft((current) => ({
      ...current,
      costItems: current.costItems.map((item, itemIndex) => (
        itemIndex === index ? { ...item, [key]: value } : item
      )),
    }));
  }

  async function postPropertyOperation(body: Record<string, unknown>) {
    const response = await fetch("/api/crm/properties", {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({ error: "Aktion konnte nicht gespeichert werden." }));
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : "Aktion konnte nicht gespeichert werden.");
    }
    return payload;
  }

  async function saveSelectedPriceVisibility() {
    if (!selectedAsset?.sellerListingId || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await postPropertyOperation({
        channelPriceVisibility: draft.channelPriceVisibility,
        operation: "update_price_visibility",
        priceVisibility: selectedAsset.priceVisibility,
        projectId: selectedAsset.projectId,
        propertyId: selectedAsset.sellerListingId,
        publicPrice: selectedAsset.publicPrice ?? selectedAsset.price,
      });
      setNotice({ kind: "success", message: "Preis-Sichtbarkeit gespeichert." });
      await onPropertyChanged?.();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Preis-Sichtbarkeit konnte nicht gespeichert werden." });
    } finally {
      setSaving(false);
    }
  }

  async function uploadAndAttachFile(file: File, kind: "media" | "document") {
    if (!selectedAsset?.sellerListingId || saving) return;
    const setUploading = kind === "media" ? setUploadingMedia : setUploadingDocument;
    setUploading(true);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("folder", `properties/${selectedAsset.sellerListingId}`);
      formData.append("name", file.name);
      formData.append("alt", file.name.replace(/\.[^.]+$/, ""));
      if (kind === "media") formData.append("public", "true");
      const uploadResponse = await fetch("/api/media", { body: formData, method: "POST" });
      const uploadPayload = await uploadResponse.json().catch(() => ({ error: "Upload fehlgeschlagen." }));
      if (!uploadResponse.ok || !uploadPayload.asset?.id) {
        throw new Error(typeof uploadPayload.error === "string" ? uploadPayload.error : "Upload fehlgeschlagen.");
      }
      await postPropertyOperation(kind === "media" ? {
        media: {
          category: file.type.startsWith("image/") ? "gallery" : "document",
          isCover: selectedMedia.length === 0,
          mediaAssetId: uploadPayload.asset.id,
          mediaType: file.type.startsWith("image/") ? "image" : "document",
          position: selectedMedia.length,
          status: "draft",
          title: file.name,
          visibility: "public",
        },
        operation: "attach_media",
        projectId: selectedAsset.projectId,
        propertyId: selectedAsset.sellerListingId,
      } : {
        document: {
          category: "expose",
          mediaAssetId: uploadPayload.asset.id,
          requiredForPublication: false,
          status: "needs_review",
          title: file.name,
          visibility: "private",
        },
        operation: "attach_document",
        projectId: selectedAsset.projectId,
        propertyId: selectedAsset.sellerListingId,
      });
      setNotice({ kind: "success", message: kind === "media" ? "Bild/Medium zugeordnet." : "Dokument zugeordnet." });
      await onPropertyChanged?.();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Upload konnte nicht gespeichert werden." });
    } finally {
      setUploading(false);
    }
  }

  async function submitProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!actions.createProperty.enabled || saving) return;
    setSaving(true);
    setNotice(null);

    try {
      const response = await fetch("/api/crm/properties", {
        body: JSON.stringify({
          operation: "create_property",
          ...draft,
          costItems: toCostItems(draft),
          publicPrice: draft.publicPrice || draft.price,
          textBlocks: toTextBlocks(draft),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({ error: "Objekt konnte nicht gespeichert werden." }));
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Objekt konnte nicht gespeichert werden.");
      }
      setNotice({ kind: "success", message: "Objekt gespeichert." });
      setDraft((current) => ({
        ...current,
        address: "",
        areaSqm: "",
        availableFrom: "",
        availableFromText: "",
        availabilityNote: "",
        costItems: createCostDrafts(),
        price: "",
        publicPrice: "",
        rooms: "",
        textBlocks: createTextDrafts(),
        title: "",
      }));
      await onPropertyChanged?.();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Objekt konnte nicht gespeichert werden." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid min-w-0 max-w-full gap-4 overflow-hidden">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
            <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">Immobilien</h3>
            <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">
              {context.workspaceName}
            </p>
          </div>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:w-[520px]">
            <ActionButton action={actions.createProperty} onClick={() => setActiveTab("create")} />
            <ActionButton action={actions.assignInquiry} onClick={() => setActiveTab("inquiries")} />
            <ActionButton action={actions.reserveUnit} onClick={onOpenUnits} />
            <ActionButton action={actions.exportChannel} onClick={() => setActiveTab("channels")} />
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {metrics.map(([label, value]) => (
            <div className="rounded-md border border-stone-200 bg-stone-50 p-4" key={label}>
              <p className="break-words text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">{formatNumber(Number(value), language)}</p>
            </div>
          ))}
        </div>
      </article>

      <nav className="max-w-full overflow-x-auto rounded-lg border border-stone-200 bg-white p-2">
        <div className="flex min-w-max gap-2">
          {PROPERTY_DEPARTMENT_TABS.map((tab) => (
            <button
              className={`rounded-md px-3 py-2 text-sm font-semibold ${
                activeTab === tab.id ? "bg-slate-950 text-white" : "text-slate-700 hover:bg-stone-100"
              }`}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {activeTab === "overview" ? (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
              <input
                className="min-w-0 rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-900"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Objekt, Ort, Projekt suchen"
                value={query}
              />
              <select
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                onChange={(event) => setStatusFilter(event.target.value as PropertyAssetStatus | "all")}
                value={statusFilter}
              >
                <option value="all">Alle Status</option>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[860px] w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.12em] text-stone-500">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">Objekt</th>
                    <th className="py-2 pr-4 font-semibold">Status</th>
                    <th className="py-2 pr-4 font-semibold">Preis</th>
                    <th className="py-2 pr-4 font-semibold">Fläche</th>
                    <th className="py-2 pr-4 font-semibold">Einheiten</th>
                    <th className="py-2 font-semibold">Anfragen</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAssets.map((asset) => (
                    <tr
                      className="cursor-pointer border-t border-stone-200 align-top hover:bg-stone-50"
                      key={asset.id}
                      onClick={() => setSelectedAssetId(asset.id)}
                    >
                      <td className="py-3 pr-4">
                        <p className="break-words font-semibold text-slate-950">{asset.title}</p>
                        <p className="mt-1 break-words text-xs text-stone-500">{asset.location} · {asset.projectName}</p>
                      </td>
                      <td className="py-3 pr-4"><StatusChip status={asset.status} /></td>
                      <td className="py-3 pr-4 font-semibold text-slate-900">{asset.price ? formatCurrency(asset.price, language) : "-"}</td>
                      <td className="py-3 pr-4 text-stone-700">{asset.areaSqm ? `${formatNumber(asset.areaSqm, language)} m2` : "-"}</td>
                      <td className="py-3 pr-4 text-stone-700">
                        {asset.unitCount ? `${asset.availableUnits} frei / ${asset.reservedUnits} reserviert / ${asset.soldUnits} verkauft` : "-"}
                      </td>
                      <td className="py-3 text-stone-700">
                        {routeResults.filter((item) => item.route.propertyId === asset.id || item.route.projectId === asset.projectId).length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            {selectedAsset ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={selectedAsset.status} />
                  <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">{selectedAsset.objectType}</span>
                </div>
                <h4 className="mt-3 break-words text-xl font-semibold text-slate-950">{selectedAsset.title}</h4>
                <p className="mt-2 break-words text-sm text-stone-600">{selectedAsset.location}</p>
                <div className="mt-4 grid gap-2 text-sm">
                  <div className="flex justify-between gap-3 rounded-md bg-stone-50 px-3 py-2">
                    <span className="text-stone-500">Projekt</span>
                    <span className="text-right font-semibold text-slate-900">{selectedAsset.projectName}</span>
                  </div>
                  <div className="flex justify-between gap-3 rounded-md bg-stone-50 px-3 py-2">
                    <span className="text-stone-500">Preis</span>
                    <span className="text-right font-semibold text-slate-900">{selectedAsset.price ? formatCurrency(selectedAsset.price, language) : "-"}</span>
                  </div>
                  <div className="flex justify-between gap-3 rounded-md bg-stone-50 px-3 py-2">
                    <span className="text-stone-500">Reservierungen</span>
                    <span className="text-right font-semibold text-slate-900">{selectedAsset.activeReservations}</span>
                  </div>
                </div>
                <div className="mt-4 grid gap-2">
                  <ActionButton action={actions.publishProperty} onClick={() => setActiveTab("channels")} />
                  <ActionButton action={actions.changePrice} />
                  <ActionButton action={actions.approveDocument} onClick={() => setActiveTab("documents")} />
                </div>
              </>
            ) : (
              <p className="text-sm text-stone-600">Keine Immobilie im aktuellen Filter.</p>
            )}
          </article>
        </div>
      ) : null}

      {activeTab === "create" ? (
        <form className="grid gap-5" onSubmit={submitProperty}>
          <div className="sticky top-3 z-20 rounded-lg border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-emerald-700">{draftProjectName}</p>
                <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
                  {draft.title.trim() || "Neues Objekt"}
                </h4>
                <p className="mt-1 text-sm leading-6 text-stone-600">
                  Preflight {draftReadyCount}/{draftPreflightItems.length}: {nextDraftIssue}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                {notice ? (
                  <span className={`rounded-md border px-3 py-2 text-sm font-semibold ${notice.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"}`}>{notice.message}</span>
                ) : null}
                <button className="min-h-12 rounded-md bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50" disabled={!actions.createProperty.enabled || saving} type="submit">
                  {saving ? "Speichern..." : actions.createProperty.label}
                </button>
              </div>
            </div>
            {!actions.createProperty.enabled && actions.createProperty.reason ? <p className="mt-3 text-sm text-stone-600">{actions.createProperty.reason}</p> : null}
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid min-w-0 gap-5">
              <PropertyFormSection
                description="Die wichtigsten Angaben stehen zuerst. Detailfelder bleiben weiter unten in aufklappbaren Gruppen verfügbar."
                title="Überblick"
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className={`${propertyFieldClass} lg:col-span-2`}>
                    <span>Titel</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("title", event.target.value)} required value={draft.title} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Projekt</span>
                    <select className={propertySelectClass} onChange={(event) => updateDraft("projectId", event.target.value)} value={draft.projectId}>
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Objektart</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("objectType", event.target.value)} value={draft.objectType} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Objektnummer</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("objectNumber", event.target.value)} value={draft.objectNumber} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Interne Referenz</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("internalReference", event.target.value)} value={draft.internalReference} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Vermarktung</span>
                    <select className={propertySelectClass} onChange={(event) => updateDraft("marketingType", event.target.value)} value={draft.marketingType}>
                      <option value="sale">Kauf</option>
                      <option value="rent">Miete</option>
                      <option value="sale_or_rent">Kauf oder Miete</option>
                    </select>
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Nutzung</span>
                    <select className={propertySelectClass} onChange={(event) => updateDraft("usageType", event.target.value)} value={draft.usageType}>
                      <option value="residential">Wohnen</option>
                      <option value="commercial">Gewerbe</option>
                      <option value="investment">Investment</option>
                      <option value="mixed">Gemischt</option>
                    </select>
                  </label>
                </div>
              </PropertyFormSection>

              <PropertyFormSection title="Adresse & Lage">
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className={`${propertyFieldClass} lg:col-span-2`}>
                    <span>Adresse</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("address", event.target.value)} required value={draft.address} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>PLZ / Ort</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("postalCode", event.target.value)} value={draft.postalCode} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Bundesland / Region</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("region", event.target.value)} value={draft.region} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Unterobjektart</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("subObjectType", event.target.value)} value={draft.subObjectType} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Verfügbarkeit Text</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("availableFromText", event.target.value)} value={draft.availableFromText} />
                  </label>
                </div>
              </PropertyFormSection>

              <PropertyFormSection title="Flächen & Verfügbarkeit">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <label className={propertyFieldClass}>
                    <span>Wohnfläche</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("areaSqm", event.target.value)} type="number" value={draft.areaSqm} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Zimmer</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("rooms", event.target.value)} type="number" value={draft.rooms} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Baujahr</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("yearBuilt", event.target.value)} type="number" value={draft.yearBuilt} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Verfügbar ab</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("availableFrom", event.target.value)} type="date" value={draft.availableFrom} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Ansprechpartner</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("contactName", event.target.value)} value={draft.contactName} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Kontakt E-Mail</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("contactEmail", event.target.value)} type="email" value={draft.contactEmail} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Kontakt Telefon</span>
                    <input className={propertyInputClass} onChange={(event) => updateDraft("contactPhone", event.target.value)} value={draft.contactPhone} />
                  </label>
                </div>
              </PropertyFormSection>

              <PropertyFormSection title="Preise & Kosten">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <label className={propertyFieldClass}>
                    <span>Kaufpreis</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("price", event.target.value)} type="number" value={draft.price} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Miete netto</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("rentNet", event.target.value)} type="number" value={draft.rentNet} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Miete brutto</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("rentPrice", event.target.value)} type="number" value={draft.rentPrice} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Kaufnebenkosten</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("purchaseAncillaryCosts", event.target.value)} type="number" value={draft.purchaseAncillaryCosts} />
                  </label>
                </div>
                <div className="mt-5 grid gap-4">
                  {PROPERTY_COST_GROUPS.map((group) => (
                    <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-4" key={group.key}>
                      <p className="text-sm font-semibold text-slate-950">{group.label}</p>
                      <div className="grid gap-3">
                        {draft.costItems.map((item, index) => item.groupKey === group.key ? (
                          <div className="grid gap-3 rounded-md bg-white p-3 md:grid-cols-[minmax(160px,1fr)_repeat(3,minmax(110px,150px))_minmax(90px,auto)]" key={item.costKey}>
                            <span className="self-center text-sm font-semibold text-slate-900">{item.label}</span>
                            <input aria-label={`${item.label} netto`} className={propertyInputClass} onChange={(event) => updateCostItem(index, group.key === "monthly" ? "monthlyNet" : "oneTimeNet", event.target.value)} placeholder="Netto" type="number" value={group.key === "monthly" ? item.monthlyNet : item.oneTimeNet} />
                            <input aria-label={`${item.label} USt`} className={propertyInputClass} onChange={(event) => updateCostItem(index, group.key === "monthly" ? "monthlyVat" : "oneTimeVat", event.target.value)} placeholder="USt" type="number" value={group.key === "monthly" ? item.monthlyVat : item.oneTimeVat} />
                            <input aria-label={`${item.label} brutto`} className={propertyInputClass} onChange={(event) => updateCostItem(index, group.key === "monthly" ? "monthlyGross" : "oneTimeGross", event.target.value)} placeholder="Brutto" type="number" value={group.key === "monthly" ? item.monthlyGross : item.oneTimeGross} />
                            <label className="flex min-h-12 items-center gap-2 text-sm font-semibold text-stone-700">
                              <input checked={item.exposeVisible} onChange={(event) => updateCostItem(index, "exposeVisible", event.target.checked)} type="checkbox" />
                              Exposé
                            </label>
                          </div>
                        ) : null)}
                      </div>
                    </div>
                  ))}
                </div>
              </PropertyFormSection>

              <PropertyFormSection
                description="Lange Marketingtexte brauchen Raum. Exposé und Website stehen daher nicht mehr in einer schmalen rechten Spalte."
                title="Texte"
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  {PROPERTY_TEXT_FIELDS.map((field) => (
                    <label className={`${propertyFieldClass} ${field.key === "expose" ? "lg:col-span-2" : ""}`} key={field.key}>
                      <span>{field.label}</span>
                      <textarea
                        className={`${propertyTextareaClass} ${field.key === "expose" ? "min-h-[240px]" : ""}`}
                        onChange={(event) => updateTextBlock(field.key, event.target.value)}
                        value={draft.textBlocks[field.key] ?? ""}
                      />
                    </label>
                  ))}
                </div>
              </PropertyFormSection>

              <PropertyFormSection
                description="Spezialisierte Angaben bleiben verfügbar, ohne die Hauptanlage zu überladen."
                title="Recht, Datenschutz & Detailfelder"
              >
                <div className="grid gap-4">
                  {PROPERTY_FIELD_SECTIONS.map((section) => (
                    <details className="rounded-md border border-stone-200 bg-stone-50 p-4" key={section.id} open={defaultOpenPropertyDetailSections.has(section.id)}>
                      <summary className="cursor-pointer text-base font-semibold text-slate-950">{section.title}</summary>
                      <div className="mt-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                        {section.fields.map((field) => (
                          <label className={propertyFieldClass} key={field}>
                            <span>{field}</span>
                            <input
                              className={propertyInputClass}
                              onChange={(event) => updateField(section.id, field, event.target.value)}
                              value={draft.fieldValues[fieldKey(section.id, field)] ?? ""}
                            />
                          </label>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </PropertyFormSection>
            </div>

            <aside className="grid content-start gap-5 xl:sticky xl:top-24">
              <PropertyFormSection
                description="Dieser Block entscheidet, ob Preise, Datenschutz und Portal-Mapping für die nächste Freigabe reichen."
                title="Veröffentlichung & Portale"
              >
                <div className="grid gap-4">
                  <label className={propertyFieldClass}>
                    <span>Preis-Sichtbarkeit</span>
                    <select className={propertySelectClass} onChange={(event) => updateDraft("priceVisibility", event.target.value as PropertyPriceVisibility)} value={draft.priceVisibility}>
                      {PROPERTY_PRICE_VISIBILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Öffentlicher Preis</span>
                    <input className={propertyInputClass} min="0" onChange={(event) => updateDraft("publicPrice", event.target.value)} type="number" value={draft.publicPrice} />
                  </label>
                  <label className={propertyFieldClass}>
                    <span>DSGVO Status</span>
                    <select className={propertySelectClass} onChange={(event) => updateDraft("gdprStatus", event.target.value)} value={draft.gdprStatus}>
                      <option value="needs_review">Prüfen</option>
                      <option value="ready">Bereit</option>
                      <option value="blocked">Blockiert</option>
                    </select>
                  </label>
                  <label className={propertyFieldClass}>
                    <span>Portal-Mapping</span>
                    <select className={propertySelectClass} onChange={(event) => updateDraft("portalMappingStatus", event.target.value)} value={draft.portalMappingStatus}>
                      <option value="needs_review">Offen</option>
                      <option value="mapped">Gemappt</option>
                      <option value="ready">Bereit</option>
                    </select>
                  </label>
                </div>
              </PropertyFormSection>

              <section className={propertyPanelClass} aria-labelledby="property-preflight-heading">
                <h4 className="text-lg font-semibold text-slate-950" id="property-preflight-heading">Preflight</h4>
                <p className="mt-2 text-sm leading-6 text-stone-600">{draftReadyCount} von {draftPreflightItems.length} Kernprüfungen erfüllt.</p>
                <div className="mt-4 grid gap-2">
                  {draftPreflightItems.map((item) => (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-stone-50 px-3 py-2 text-sm" key={item.label}>
                      <span className="font-semibold text-slate-900">{item.label}</span>
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${item.ready ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
                        {item.ready ? "Bereit" : "Offen"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section className={propertyPanelClass} aria-labelledby="property-media-heading">
                <h4 className="text-lg font-semibold text-slate-950" id="property-media-heading">Medien & Dokumente</h4>
                <p className="mt-2 text-sm leading-6 text-stone-600">Bilder, Grundrisse, Energieausweis und Freigabedokumente werden im Dokumente-Tab gepflegt.</p>
                <button className="mt-4 min-h-11 w-full rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50" onClick={() => setActiveTab("documents")} type="button">
                  Dokumente öffnen
                </button>
              </section>

              <section className={propertyPanelClass} aria-labelledby="property-history-heading">
                <h4 className="text-lg font-semibold text-slate-950" id="property-history-heading">Historie / Aktivitäten</h4>
                <p className="mt-2 text-sm leading-6 text-stone-600">Nach dem Speichern erscheinen Objektänderungen, Anfragen und Reservierungen in Historie und Aktivitäten.</p>
                <button className="mt-4 min-h-11 w-full rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50" onClick={() => setActiveTab("activity")} type="button">
                  Aktivitäten öffnen
                </button>
              </section>
            </aside>
          </div>
        </form>
      ) : null}

      {activeTab === "projectUnits" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h4 className="text-lg font-semibold text-slate-950">Projekt / Gebäude / Einheiten</h4>
            <button className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50" onClick={onOpenUnits} type="button">Einheitenboard öffnen</button>
          </div>
          <div className="mt-4 grid gap-3">
            {projects.map((project) => {
              const projectBuildings = buildings.filter((building) => building.projectId === project.id);
              const projectUnits = units.filter((unit) => unit.projectId === project.id);
              return (
                <div className="rounded-md border border-stone-200 bg-stone-50 p-4" key={project.id}>
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">{project.name}</p>
                      <p className="mt-1 text-sm text-stone-600">{project.type}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-semibold">
                      <span className="rounded-md bg-white px-2 py-1">{projectBuildings.length} Gebäude</span>
                      <span className="rounded-md bg-white px-2 py-1">{projectUnits.length} Einheiten</span>
                      <span className="rounded-md bg-white px-2 py-1">{projectUnits.filter((unit) => unit.status === "available").length} frei</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      ) : null}

      {activeTab === "reservations" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h4 className="text-lg font-semibold text-slate-950">Reservierungen</h4>
            <button className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50" onClick={onOpenReservations} type="button">Reservierungsboard öffnen</button>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {activeReservations.map((reservation) => {
              const unit = units.find((item) => item.id === reservation.unitId);
              const contact = contacts.find((item) => item.id === reservation.contactId);
              const days = daysUntil(reservation.expiresAt);
              return (
                <div className="rounded-md border border-stone-200 bg-stone-50 p-4" key={reservation.id}>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-900">{reservation.status}</span>
                    <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{days === null ? "-" : `${days} Tage`}</span>
                  </div>
                  <p className="mt-3 font-semibold text-slate-950">Einheit {unit?.unitNumber ?? reservation.unitId}</p>
                  <p className="mt-1 text-sm text-stone-600">{contact?.name ?? "Kein Kontakt"} · {formatCurrency(reservation.depositCents / 100, language)}</p>
                  <p className="mt-2 text-sm text-stone-700">{reservation.nextAction}</p>
                </div>
              );
            })}
          </div>
        </article>
      ) : null}

      {activeTab === "inquiries" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h4 className="text-lg font-semibold text-slate-950">Anfrage-Routing</h4>
            <button className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50" onClick={onOpenLeadInbox} type="button">Lead-Zentrale öffnen</button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[960px] w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.12em] text-stone-500">
                <tr>
                  <th className="py-2 pr-4 font-semibold">Anfrage</th>
                  <th className="py-2 pr-4 font-semibold">Quelle</th>
                  <th className="py-2 pr-4 font-semibold">Zuordnung</th>
                  <th className="py-2 pr-4 font-semibold">Confidence</th>
                  <th className="py-2 font-semibold">Hinweis</th>
                </tr>
              </thead>
              <tbody>
                {routeResults.map(({ lead, route }) => (
                  <tr className="border-t border-stone-200 align-top" key={lead.id}>
                    <td className="py-3 pr-4">
                      <p className="font-semibold text-slate-950">{lead.intent}</p>
                      <p className="mt-1 text-xs text-stone-500">{contacts.find((contact) => contact.id === lead.contactId)?.name ?? lead.contactId}</p>
                    </td>
                    <td className="py-3 pr-4 text-stone-700">{route.sourceChannel}</td>
                    <td className="py-3 pr-4 text-stone-700">{route.unitId ?? route.propertyId ?? route.projectId ?? "Manuell"}</td>
                    <td className="py-3 pr-4 font-semibold text-slate-900">{Math.round(route.confidenceScore * 100)}%</td>
                    <td className="py-3 text-stone-700">{route.warnings[0] ?? route.routingReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ) : null}

      {activeTab === "channels" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_240px]">
            <h4 className="text-lg font-semibold text-slate-950">Vermarktung / Kanäle</h4>
            <select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900" onChange={(event) => setSelectedChannel(event.target.value as (typeof PROPERTY_CHANNEL_TYPES)[number])} value={selectedChannel}>
              {PROPERTY_CHANNEL_TYPES.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
            </select>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              {PROPERTY_CHANNEL_PRICE_KEYS.map((channel) => (
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500" key={channel}>
                  {channel}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-2 py-2 text-xs font-semibold normal-case tracking-normal text-slate-900"
                    onChange={(event) => updateChannelPrice(channel, event.target.value as PropertyPriceVisibility)}
                    value={draft.channelPriceVisibility[channel] ?? "publish_price"}
                  >
                    {PROPERTY_PRICE_VISIBILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="grid gap-2">
              <button className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50" disabled={!selectedAsset?.sellerListingId || saving || !actions.changePrice.enabled} onClick={saveSelectedPriceVisibility} type="button">
                Preislogik speichern
              </button>
              {!actions.changePrice.enabled && actions.changePrice.reason ? <p className="text-xs text-stone-600">{actions.changePrice.reason}</p> : null}
            </div>
          </div>
          {selectedAsset ? (
            <div className="mt-4 grid gap-2 text-xs font-semibold text-stone-600 sm:grid-cols-2 lg:grid-cols-5">
              <span className="rounded-md bg-stone-50 px-3 py-2">Texte: {selectedTextBlocks.length}</span>
              <span className="rounded-md bg-stone-50 px-3 py-2">Bilder: {selectedMedia.length}</span>
              <span className="rounded-md bg-stone-50 px-3 py-2">Dokumente: {selectedDocuments.length}</span>
              <span className="rounded-md bg-stone-50 px-3 py-2">Kosten: {selectedCostItems.length}</span>
              <span className="rounded-md bg-stone-50 px-3 py-2">Preis: {selectedAsset.priceVisibility}</span>
            </div>
          ) : null}
          {preflight ? (
            <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <div className="rounded-md border border-stone-200 bg-stone-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Preflight</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{preflight.status}</p>
                <div className="mt-4 grid gap-2">
                  <ActionButton action={actions.publishProperty} />
                  <ActionButton action={actions.exportChannel} />
                </div>
              </div>
              <div className="grid gap-2">
                {preflight.checks.map((check) => (
                  <div className="flex flex-col gap-1 rounded-md border border-stone-200 bg-stone-50 p-3 sm:flex-row sm:items-center sm:justify-between" key={check.id}>
                    <div>
                      <p className="font-semibold text-slate-950">{check.label}</p>
                      <p className="text-xs text-stone-600">{check.message}</p>
                    </div>
                    <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{check.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </article>
      ) : null}

      {activeTab === "documents" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <h4 className="text-lg font-semibold text-slate-950">Dokumente / Exposé</h4>
            <div className="flex flex-wrap gap-2">
              <label className="cursor-pointer rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50">
                {uploadingMedia ? "Upload..." : "Bild hochladen"}
                <input
                  accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                  className="sr-only"
                  disabled={!selectedAsset?.sellerListingId || uploadingMedia}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAndAttachFile(file, "media");
                    event.currentTarget.value = "";
                  }}
                  type="file"
                />
              </label>
              <label className="cursor-pointer rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50">
                {uploadingDocument ? "Upload..." : "Dokument hochladen"}
                <input
                  accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="sr-only"
                  disabled={!selectedAsset?.sellerListingId || uploadingDocument}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAndAttachFile(file, "document");
                    event.currentTarget.value = "";
                  }}
                  type="file"
                />
              </label>
              <ActionButton action={actions.approveDocument} />
            </div>
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <section className="grid gap-3">
              <div className="flex flex-wrap gap-2 text-xs font-semibold text-stone-600">
                {PROPERTY_MEDIA_CATEGORIES.map((category) => (
                  <span className="rounded-md bg-stone-50 px-2 py-1" key={category}>{category}</span>
                ))}
              </div>
              <div className="grid gap-2">
                {selectedMedia.length ? selectedMedia.map((media) => (
                  <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3 sm:grid-cols-[88px_minmax(0,1fr)_120px]" key={media.id}>
                    <span
                      className="h-20 rounded-md bg-stone-200 bg-cover bg-center"
                      role="img"
                      style={{ backgroundImage: media.publicUrl || media.url ? `url("${media.publicUrl ?? media.url}")` : undefined }}
                    />
                    <span className="min-w-0">
                      <strong className="block break-words text-sm text-slate-950">{media.title || media.assetName}</strong>
                      <span className="mt-1 block text-xs font-semibold text-stone-500">{media.category} / {media.visibility}</span>
                      <span className="mt-1 block text-xs text-stone-600">{media.isCover ? "Titelbild" : "Galerie"} / Position {media.position}</span>
                    </span>
                    <span className="self-start rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{media.status}</span>
                  </div>
                )) : (
                  <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-600">Noch keine Bilder am Objekt.</p>
                )}
              </div>
            </section>
            <section className="grid gap-3">
              <div className="flex flex-wrap gap-2 text-xs font-semibold text-stone-600">
                {PROPERTY_DOCUMENT_CATEGORIES.map((category) => (
                  <span className="rounded-md bg-stone-50 px-2 py-1" key={category}>{category}</span>
                ))}
              </div>
              <div className="grid gap-2">
                {selectedDocuments.length ? selectedDocuments.map((document) => (
                  <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3 sm:grid-cols-[minmax(0,1fr)_120px]" key={document.id}>
                    <span className="min-w-0">
                      <strong className="block break-words text-sm text-slate-950">{document.title || document.assetName}</strong>
                      <span className="mt-1 block text-xs font-semibold text-stone-500">{document.category} / {document.visibility}</span>
                      <span className="mt-1 block text-xs text-stone-600">{document.requiredForPublication ? "Pflicht für Publikation" : "Optional"}{document.publicUrl ? " / öffentlich" : ""}</span>
                    </span>
                    <span className="self-start rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{document.status}</span>
                  </div>
                )) : (
                  <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-600">Noch keine Dokumente am Objekt.</p>
                )}
              </div>
            </section>
          </div>
        </article>
      ) : null}

      {activeTab === "matching" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <h4 className="text-lg font-semibold text-slate-950">Käufer- und Investorenmatching</h4>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {matches.length ? matches.map((match) => (
              <div className="rounded-md border border-stone-200 bg-stone-50 p-4" key={`${match.asset.id}:${match.profile?.id ?? match.lead?.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{match.asset.title}</p>
                    <p className="mt-1 text-sm text-stone-600">{match.contact?.name ?? match.profile?.title ?? match.lead?.intent}</p>
                  </div>
                  <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-emerald-800">{match.score}%</span>
                </div>
                <p className="mt-2 text-xs font-semibold text-stone-500">{match.reasons.join(" / ")}</p>
              </div>
            )) : (
              <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-600">Keine Treffer im aktuellen Filter.</p>
            )}
          </div>
        </article>
      ) : null}

      {activeTab === "quality" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <h4 className="text-lg font-semibold text-slate-950">Datenqualität</h4>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {qualityIssues.map((issue, index) => (
              <div className="rounded-md border border-stone-200 bg-stone-50 p-4" key={`${issue.title}:${index}`}>
                <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{issue.severity}</span>
                <p className="mt-3 font-semibold text-slate-950">{issue.title}</p>
                <p className="mt-1 text-sm text-stone-600">{issue.message}</p>
              </div>
            ))}
          </div>
        </article>
      ) : null}

      {activeTab === "activity" ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <h4 className="text-lg font-semibold text-slate-950">Aktivitäten / Historie</h4>
          <div className="mt-4 grid gap-3">
            {[
              ...activeReservations.map((reservation) => ({
                id: `reservation:${reservation.id}`,
                label: "Reservierung",
                title: reservation.nextAction || reservation.unitId,
                time: reservation.expiresAt,
              })),
              ...leads.slice(0, 8).map((lead) => ({
                id: `lead:${lead.id}`,
                label: lead.source,
                title: lead.nextAction || lead.intent,
                time: lead.receivedAt,
              })),
            ].map((event) => (
              <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-4 md:grid-cols-[140px_minmax(0,1fr)_180px]" key={event.id}>
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{event.label}</span>
                <span className="break-words text-sm font-semibold text-slate-950">{event.title}</span>
                <span className="text-sm text-stone-600">{formatDate(event.time, language)}</span>
              </div>
            ))}
          </div>
        </article>
      ) : null}
    </section>
  );
}
