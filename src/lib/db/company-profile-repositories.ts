import type { AppSession } from "@/lib/auth/session";
import type {
  CompanyProfile,
  CompanyProfileCountry,
  CompanyProfilePreflightIssue,
  CompanyProfileScope,
  CompanyProfileStatus,
  CompanyProfileUsageKey,
  CompanyProfileVersion,
} from "@/lib/crm-types";
import { companyLegalDetails, publicSiteOrigin } from "@/lib/legal";
import { executeQuery, hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { hasProductCapability } from "@/lib/product-model";

export type CompanyProfilePayload = {
  canApprove: boolean;
  canEdit: boolean;
  fieldRequirements: CountryFieldRequirement[];
  preflight: {
    blockers: CompanyProfilePreflightIssue[];
    issues: CompanyProfilePreflightIssue[];
    warnings: CompanyProfilePreflightIssue[];
  };
  profile: CompanyProfile;
  source: "database" | "fallback";
  versions: CompanyProfileVersion[];
};

export type CountryFieldRequirement = {
  appliesToRealEstate?: boolean;
  countryCode: "AT" | "DE" | "IE";
  field: keyof CompanyProfile | "licenses.realEstate" | "representatives";
  label: string;
  required: boolean;
};

type CompanyProfileRow = {
  approvedAt: string | Date | null;
  approvedByUserId: string | null;
  billingAddress: string;
  brand: unknown;
  businessAddress: string;
  countryCode: string;
  createdAt: string | Date;
  displayName: string;
  dpoContact: string;
  id: string;
  jurisdiction: string;
  legalForm: string;
  legalName: string;
  licenses: unknown;
  organizationId: string | null;
  privacyContact: string;
  profileScope: CompanyProfileScope;
  publicEmail: string;
  publicPhone: string;
  registerCourt: string;
  registeredOfficeAddress: string;
  registrationAuthority: string;
  registrationNumber: string;
  representatives: unknown;
  status: CompanyProfileStatus;
  taxNumber: string;
  updatedAt: string | Date;
  usageSettings: unknown;
  vatId: string;
  website: string;
  workspaceId: string | null;
};

type CompanyProfileVersionRow = {
  action: string;
  actorUserId: string | null;
  changedFields: string[] | null;
  companyProfileId: string;
  createdAt: string | Date;
  id: string;
  workspaceId: string | null;
};

type CompanyProfileInput = Partial<
  Omit<CompanyProfile, "approvedAt" | "approvedByUserId" | "createdAt" | "id" | "updatedAt" | "workspaceId">
> & {
  organizationId?: unknown;
  profileScope?: unknown;
};

type MutableCompanyProfileFields = Omit<
  CompanyProfile,
  "approvedAt" | "approvedByUserId" | "createdAt" | "id" | "updatedAt" | "workspaceId"
>;

const legalFieldKeys: Array<keyof MutableCompanyProfileFields> = [
  "legalName",
  "displayName",
  "legalForm",
  "countryCode",
  "jurisdiction",
  "registrationNumber",
  "registrationAuthority",
  "registerCourt",
  "vatId",
  "taxNumber",
  "registeredOfficeAddress",
  "businessAddress",
  "billingAddress",
  "publicEmail",
  "publicPhone",
  "website",
  "representatives",
  "privacyContact",
  "dpoContact",
  "licenses",
  "brand",
  "usageSettings",
  "status",
];

const countryRequirements: CountryFieldRequirement[] = [
  { countryCode: "AT", field: "legalName", label: "Firmenname", required: true },
  { countryCode: "AT", field: "legalForm", label: "Rechtsform", required: true },
  { countryCode: "AT", field: "businessAddress", label: "Sitz/Geschäftsanschrift", required: true },
  { countryCode: "AT", field: "publicEmail", label: "Kontakt/E-Mail", required: true },
  { countryCode: "AT", field: "registrationNumber", label: "Firmenbuchnummer", required: false },
  { countryCode: "AT", field: "registrationAuthority", label: "Firmenbuchgericht", required: false },
  { countryCode: "AT", field: "vatId", label: "UID-Nummer", required: false },
  { countryCode: "AT", field: "representatives", label: "Vertretungsbefugte Personen", required: true },
  { appliesToRealEstate: true, countryCode: "AT", field: "licenses.realEstate", label: "Gewerbeberechtigung/Immobilientreuhänder", required: true },
  { countryCode: "DE", field: "legalName", label: "Firmenname", required: true },
  { countryCode: "DE", field: "legalForm", label: "Rechtsform", required: true },
  { countryCode: "DE", field: "businessAddress", label: "Sitz/Geschäftsanschrift", required: true },
  { countryCode: "DE", field: "publicEmail", label: "Kontakt/E-Mail", required: true },
  { countryCode: "DE", field: "registrationNumber", label: "Handelsregisternummer", required: false },
  { countryCode: "DE", field: "registerCourt", label: "Registergericht", required: false },
  { countryCode: "DE", field: "vatId", label: "Umsatzsteuer-ID", required: false },
  { countryCode: "DE", field: "representatives", label: "Vertretungsberechtigte", required: true },
  { appliesToRealEstate: true, countryCode: "DE", field: "licenses.realEstate", label: "Erlaubnis nach Paragraph 34c GewO", required: true },
  { countryCode: "IE", field: "legalName", label: "Company name", required: true },
  { countryCode: "IE", field: "legalForm", label: "Legal form", required: true },
  { countryCode: "IE", field: "registrationNumber", label: "CRO registration number", required: true },
  { countryCode: "IE", field: "registrationAuthority", label: "Place/authority of registration", required: true },
  { countryCode: "IE", field: "registeredOfficeAddress", label: "Registered office", required: true },
  { countryCode: "IE", field: "businessAddress", label: "Business address", required: true },
  { countryCode: "IE", field: "publicEmail", label: "Contact email", required: true },
  { countryCode: "IE", field: "representatives", label: "Directors / authorised representatives", required: true },
  { appliesToRealEstate: true, countryCode: "IE", field: "licenses.realEstate", label: "PSRA licence information", required: true },
];

function stringifyDate(value: string | Date | null | undefined) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanCountry(value: unknown): CompanyProfileCountry {
  const country = cleanString(value).toUpperCase();
  return country || "AT";
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function normalizeScope(value: unknown): CompanyProfileScope {
  return value === "platform_operator" || value === "crm_account" || value === "workspace_owner"
    ? value
    : "workspace_owner";
}

function normalizeStatus(value: unknown, fallback: CompanyProfileStatus): CompanyProfileStatus {
  return value === "draft" || value === "needs_review" || value === "approved" || value === "locked"
    ? value
    : fallback;
}

function toProfile(row: CompanyProfileRow): CompanyProfile {
  return {
    approvedAt: stringifyDate(row.approvedAt),
    approvedByUserId: row.approvedByUserId ?? undefined,
    billingAddress: row.billingAddress ?? "",
    brand: asObject(row.brand),
    businessAddress: row.businessAddress ?? "",
    countryCode: row.countryCode || "AT",
    createdAt: stringifyDate(row.createdAt) ?? new Date().toISOString(),
    displayName: row.displayName ?? "",
    dpoContact: row.dpoContact ?? "",
    id: row.id,
    jurisdiction: row.jurisdiction ?? "",
    legalForm: row.legalForm ?? "",
    legalName: row.legalName ?? "",
    licenses: asObject(row.licenses),
    organizationId: row.organizationId ?? undefined,
    privacyContact: row.privacyContact ?? "",
    profileScope: row.profileScope,
    publicEmail: row.publicEmail ?? "",
    publicPhone: row.publicPhone ?? "",
    registerCourt: row.registerCourt ?? "",
    registeredOfficeAddress: row.registeredOfficeAddress ?? "",
    registrationAuthority: row.registrationAuthority ?? "",
    registrationNumber: row.registrationNumber ?? "",
    representatives: asArray(row.representatives),
    status: row.status,
    taxNumber: row.taxNumber ?? "",
    updatedAt: stringifyDate(row.updatedAt) ?? new Date().toISOString(),
    usageSettings: asObject(row.usageSettings) as CompanyProfile["usageSettings"],
    vatId: row.vatId ?? "",
    website: row.website ?? "",
    workspaceId: row.workspaceId ?? undefined,
  };
}

function toVersion(row: CompanyProfileVersionRow): CompanyProfileVersion {
  return {
    action: row.action,
    actorUserId: row.actorUserId ?? undefined,
    changedFields: row.changedFields ?? [],
    companyProfileId: row.companyProfileId,
    createdAt: stringifyDate(row.createdAt) ?? new Date().toISOString(),
    id: row.id,
    workspaceId: row.workspaceId ?? undefined,
  };
}

function buildFallbackProfile(scope: CompanyProfileScope, session: AppSession, organizationId?: string): CompanyProfile {
  const now = new Date().toISOString();

  if (scope === "platform_operator") {
    return {
      billingAddress: companyLegalDetails.registeredOffice,
      brand: { businessName: companyLegalDetails.businessName },
      businessAddress: companyLegalDetails.registeredOffice,
      countryCode: "IE",
      createdAt: now,
      displayName: companyLegalDetails.businessName,
      dpoContact: "",
      id: "fallback-platform-operator",
      jurisdiction: companyLegalDetails.registeredPlace,
      legalForm: companyLegalDetails.legalForm,
      legalName: companyLegalDetails.companyName,
      licenses: {},
      privacyContact: companyLegalDetails.email,
      profileScope: "platform_operator",
      publicEmail: companyLegalDetails.email,
      publicPhone: companyLegalDetails.phone,
      registerCourt: "",
      registeredOfficeAddress: companyLegalDetails.registeredOffice,
      registrationAuthority: companyLegalDetails.registeredWith,
      registrationNumber: companyLegalDetails.companyNumber,
      representatives: [],
      status: "approved",
      taxNumber: "",
      updatedAt: now,
      usageSettings: { emails: true, imprint: true, legalFooter: true, privacy: true },
      vatId: "",
      website: publicSiteOrigin,
    };
  }

  return {
    billingAddress: "",
    brand: {},
    businessAddress: "",
    countryCode: "AT",
    createdAt: now,
    displayName: session.workspaceName,
    dpoContact: "",
    id: `fallback-${scope}`,
    jurisdiction: "",
    legalForm: "",
    legalName: session.workspaceName,
    licenses: {},
    organizationId,
    privacyContact: "",
    profileScope: scope,
    publicEmail: "",
    publicPhone: "",
    registerCourt: "",
    registeredOfficeAddress: "",
    registrationAuthority: "",
    registrationNumber: "",
    representatives: [],
    status: "draft",
    taxNumber: "",
    updatedAt: now,
    usageSettings: {},
    vatId: "",
    website: "",
    workspaceId: session.workspaceId,
  };
}

function isNovalureAdmin(session: AppSession) {
  return session.productRole === "platform_admin" || session.productRole === "novalureAdmin";
}

function canEditScope(session: AppSession, scope: CompanyProfileScope) {
  if (scope === "platform_operator") return isNovalureAdmin(session);
  if (scope === "workspace_owner") {
    return (
      session.productRole === "customer_owner" ||
      session.productRole === "workspace_admin" ||
      session.productRole === "platform_admin" ||
      session.productRole === "novalureAdmin" ||
      session.productRole === "novalure_onboarding" ||
      session.productRole === "novalure_customer_success" ||
      session.role === "owner"
    );
  }
  return session.role === "owner" || session.role === "admin" || hasProductCapability(session.productRole, "settings:manage");
}

function canApproveScope(session: AppSession, scope: CompanyProfileScope) {
  if (scope === "platform_operator") return isNovalureAdmin(session);
  return session.productRole === "customer_owner" || session.productRole === "workspace_admin" || session.role === "owner";
}

function fieldValue(profile: CompanyProfile, field: CountryFieldRequirement["field"]) {
  if (field === "licenses.realEstate") return asObject(profile.licenses).realEstate;
  if (field === "representatives") return profile.representatives;
  return profile[field as keyof CompanyProfile];
}

function hasValue(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function isRealEstateProfile(profile: CompanyProfile, session: AppSession) {
  const customerType = session.workspaceCustomerType ?? "";
  if (customerType === "real_estate_broker" || customerType === "property_developer" || customerType === "hybrid_real_estate") {
    return true;
  }
  return Boolean(asObject(profile.licenses).realEstate);
}

export function getCountryFieldRequirements(countryCode: string) {
  const country = countryCode.toUpperCase();
  return countryRequirements.filter((item) => item.countryCode === country);
}

export function runCompanyProfilePreflight(profile: CompanyProfile, session: AppSession): CompanyProfilePreflightIssue[] {
  const issues: CompanyProfilePreflightIssue[] = [];
  const realEstate = isRealEstateProfile(profile, session);
  const requirements = getCountryFieldRequirements(profile.countryCode);

  if (!requirements.length) {
    issues.push({
      field: "countryCode",
      message: "Landesspezifische Pflichtfelder sind nur für AT, DE und IE vorbereitet.",
      severity: "warning",
    });
  }

  for (const requirement of requirements) {
    if (requirement.appliesToRealEstate && !realEstate) continue;
    if (!requirement.required && !requirement.appliesToRealEstate) continue;
    if (!hasValue(fieldValue(profile, requirement.field))) {
      issues.push({
        field: String(requirement.field),
        message: `${requirement.label} fehlt.`,
        severity: "blocker",
      });
    }
  }

  const externalUsages: CompanyProfileUsageKey[] = [
    "customerApprovals",
    "emails",
    "exposes",
    "forms",
    "imprint",
    "invoices",
    "legalFooter",
    "openImmo",
    "portalExport",
    "privacy",
  ];

  for (const usage of externalUsages) {
    if (profile.usageSettings[usage] && profile.status !== "approved" && profile.status !== "locked") {
      issues.push({
        field: "status",
        message: `Freigabe fehlt für ${usage}.`,
        severity: "blocker",
        usage,
      });
    }
  }

  if (profile.publicEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.publicEmail)) {
    issues.push({ field: "publicEmail", message: "Öffentliche E-Mail ist formal ungültig.", severity: "warning" });
  }

  if (profile.vatId && profile.countryCode && !profile.vatId.toUpperCase().startsWith(profile.countryCode.toUpperCase())) {
    issues.push({ field: "vatId", message: "VAT/UID passt nicht zum ausgewählten Land.", severity: "warning" });
  }

  return issues;
}

async function findProfile(scope: CompanyProfileScope, session: AppSession, organizationId?: string) {
  if (scope === "platform_operator") {
    return queryOne<CompanyProfileRow>(
      `
        select
          id,
          profile_scope as "profileScope",
          workspace_id as "workspaceId",
          organization_id as "organizationId",
          legal_name as "legalName",
          display_name as "displayName",
          legal_form as "legalForm",
          country_code as "countryCode",
          jurisdiction,
          registration_number as "registrationNumber",
          registration_authority as "registrationAuthority",
          register_court as "registerCourt",
          vat_id as "vatId",
          tax_number as "taxNumber",
          registered_office_address as "registeredOfficeAddress",
          business_address as "businessAddress",
          billing_address as "billingAddress",
          public_email as "publicEmail",
          public_phone as "publicPhone",
          website,
          representatives,
          privacy_contact as "privacyContact",
          dpo_contact as "dpoContact",
          licenses,
          brand,
          usage_settings as "usageSettings",
          status,
          approved_by_user_id as "approvedByUserId",
          approved_at as "approvedAt",
          created_at as "createdAt",
          updated_at as "updatedAt"
        from company_profiles
        where profile_scope = 'platform_operator'
        limit 1
      `,
    );
  }

  if (scope === "crm_account") {
    return queryOne<CompanyProfileRow>(
      `
        select
          id,
          profile_scope as "profileScope",
          workspace_id as "workspaceId",
          organization_id as "organizationId",
          legal_name as "legalName",
          display_name as "displayName",
          legal_form as "legalForm",
          country_code as "countryCode",
          jurisdiction,
          registration_number as "registrationNumber",
          registration_authority as "registrationAuthority",
          register_court as "registerCourt",
          vat_id as "vatId",
          tax_number as "taxNumber",
          registered_office_address as "registeredOfficeAddress",
          business_address as "businessAddress",
          billing_address as "billingAddress",
          public_email as "publicEmail",
          public_phone as "publicPhone",
          website,
          representatives,
          privacy_contact as "privacyContact",
          dpo_contact as "dpoContact",
          licenses,
          brand,
          usage_settings as "usageSettings",
          status,
          approved_by_user_id as "approvedByUserId",
          approved_at as "approvedAt",
          created_at as "createdAt",
          updated_at as "updatedAt"
        from company_profiles
        where profile_scope = 'crm_account'
          and workspace_id = $1
          and organization_id = $2
        limit 1
      `,
      [session.workspaceId, organizationId],
    );
  }

  return queryOne<CompanyProfileRow>(
    `
      select
        id,
        profile_scope as "profileScope",
        workspace_id as "workspaceId",
        organization_id as "organizationId",
        legal_name as "legalName",
        display_name as "displayName",
        legal_form as "legalForm",
        country_code as "countryCode",
        jurisdiction,
        registration_number as "registrationNumber",
        registration_authority as "registrationAuthority",
        register_court as "registerCourt",
        vat_id as "vatId",
        tax_number as "taxNumber",
        registered_office_address as "registeredOfficeAddress",
        business_address as "businessAddress",
        billing_address as "billingAddress",
        public_email as "publicEmail",
        public_phone as "publicPhone",
        website,
        representatives,
        privacy_contact as "privacyContact",
        dpo_contact as "dpoContact",
        licenses,
        brand,
        usage_settings as "usageSettings",
        status,
        approved_by_user_id as "approvedByUserId",
        approved_at as "approvedAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from company_profiles
      where profile_scope = 'workspace_owner'
        and workspace_id = $1
      limit 1
    `,
    [session.workspaceId],
  );
}

async function listVersions(profileId: string) {
  if (!isUuid(profileId)) return [];

  const rows = await queryRows<CompanyProfileVersionRow>(
    `
      select
        id,
        company_profile_id as "companyProfileId",
        workspace_id as "workspaceId",
        actor_user_id as "actorUserId",
        action,
        changed_fields as "changedFields",
        created_at as "createdAt"
      from company_profile_versions
      where company_profile_id = $1
      order by created_at desc
      limit 25
    `,
    [profileId],
  );

  return rows.map(toVersion);
}

export async function getCompanyProfilePayload(input: {
  organizationId?: string;
  profileScope?: unknown;
  session: AppSession;
}): Promise<CompanyProfilePayload> {
  const scope = normalizeScope(input.profileScope);
  const organizationId = input.organizationId && isUuid(input.organizationId) ? input.organizationId : undefined;
  const canEdit = canEditScope(input.session, scope);
  const canApprove = canApproveScope(input.session, scope);

  if (!hasDatabaseUrl()) {
    const profile = buildFallbackProfile(scope, input.session, organizationId);
    const issues = runCompanyProfilePreflight(profile, input.session);
    return {
      canApprove,
      canEdit,
      fieldRequirements: getCountryFieldRequirements(profile.countryCode),
      preflight: {
        blockers: issues.filter((issue) => issue.severity === "blocker"),
        issues,
        warnings: issues.filter((issue) => issue.severity === "warning"),
      },
      profile,
      source: "fallback",
      versions: [],
    };
  }

  const row = await findProfile(scope, input.session, organizationId);
  const profile = row ? toProfile(row) : buildFallbackProfile(scope, input.session, organizationId);
  const issues = runCompanyProfilePreflight(profile, input.session);

  return {
    canApprove,
    canEdit,
    fieldRequirements: getCountryFieldRequirements(profile.countryCode),
    preflight: {
      blockers: issues.filter((issue) => issue.severity === "blocker"),
      issues,
      warnings: issues.filter((issue) => issue.severity === "warning"),
    },
    profile,
    source: row ? "database" : "fallback",
    versions: row ? await listVersions(row.id) : [],
  };
}

function sanitizeProfileInput(input: CompanyProfileInput, existing: CompanyProfile, canApprove: boolean): MutableCompanyProfileFields {
  const requestedStatus = normalizeStatus(input.status, existing.status);
  const status = canApprove || (requestedStatus !== "approved" && requestedStatus !== "locked")
    ? requestedStatus
    : "needs_review";

  return {
    billingAddress: cleanString(input.billingAddress ?? existing.billingAddress),
    brand: asObject(input.brand ?? existing.brand),
    businessAddress: cleanString(input.businessAddress ?? existing.businessAddress),
    countryCode: cleanCountry(input.countryCode ?? existing.countryCode),
    displayName: cleanString(input.displayName ?? existing.displayName),
    dpoContact: cleanString(input.dpoContact ?? existing.dpoContact),
    jurisdiction: cleanString(input.jurisdiction ?? existing.jurisdiction),
    legalForm: cleanString(input.legalForm ?? existing.legalForm),
    legalName: cleanString(input.legalName ?? existing.legalName),
    licenses: asObject(input.licenses ?? existing.licenses),
    organizationId: existing.organizationId,
    privacyContact: cleanString(input.privacyContact ?? existing.privacyContact),
    profileScope: existing.profileScope,
    publicEmail: cleanString(input.publicEmail ?? existing.publicEmail),
    publicPhone: cleanString(input.publicPhone ?? existing.publicPhone),
    registerCourt: cleanString(input.registerCourt ?? existing.registerCourt),
    registeredOfficeAddress: cleanString(input.registeredOfficeAddress ?? existing.registeredOfficeAddress),
    registrationAuthority: cleanString(input.registrationAuthority ?? existing.registrationAuthority),
    registrationNumber: cleanString(input.registrationNumber ?? existing.registrationNumber),
    representatives: asArray(input.representatives ?? existing.representatives),
    status,
    taxNumber: cleanString(input.taxNumber ?? existing.taxNumber),
    usageSettings: asObject(input.usageSettings ?? existing.usageSettings) as CompanyProfile["usageSettings"],
    vatId: cleanString(input.vatId ?? existing.vatId),
    website: cleanString(input.website ?? existing.website),
  };
}

function getChangedFields(before: CompanyProfile | null, after: MutableCompanyProfileFields) {
  if (!before) return [...legalFieldKeys];

  return legalFieldKeys.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

export async function saveCompanyProfile(input: {
  body: CompanyProfileInput;
  organizationId?: string;
  profileScope?: unknown;
  session: AppSession;
}) {
  if (!canPersist() || !hasDatabaseUrl()) {
    return { ok: false as const, reason: "Database persistence is not configured", status: 503 };
  }

  const scope = normalizeScope(input.profileScope ?? input.body.profileScope);
  const organizationId = input.organizationId && isUuid(input.organizationId) ? input.organizationId : undefined;
  if (scope === "crm_account" && !organizationId) {
    return { ok: false as const, reason: "organizationId is required for CRM account profiles", status: 400 };
  }
  if (!canEditScope(input.session, scope)) {
    return { ok: false as const, reason: "Company profile access is not allowed for this role", status: 403 };
  }

  const existingRow = await findProfile(scope, input.session, organizationId);
  const existing = existingRow ? toProfile(existingRow) : buildFallbackProfile(scope, input.session, organizationId);
  if (existing.status === "locked" && !canApproveScope(input.session, scope)) {
    return { ok: false as const, reason: "Company profile is locked", status: 423 };
  }

  const canApprove = canApproveScope(input.session, scope);
  const next = sanitizeProfileInput(input.body, existing, canApprove);
  const changedFields = getChangedFields(existingRow ? existing : null, next);
  const approvedByUserId = canApprove && (next.status === "approved" || next.status === "locked") && isUuid(input.session.userId)
    ? input.session.userId
    : existing.approvedByUserId ?? null;
  const approvedAt = canApprove && (next.status === "approved" || next.status === "locked")
    ? new Date().toISOString()
    : existing.approvedAt ?? null;

  const row = existingRow
    ? await queryOne<CompanyProfileRow>(
        `
          update company_profiles
          set
            legal_name = $2,
            display_name = $3,
            legal_form = $4,
            country_code = $5,
            jurisdiction = $6,
            registration_number = $7,
            registration_authority = $8,
            register_court = $9,
            vat_id = $10,
            tax_number = $11,
            registered_office_address = $12,
            business_address = $13,
            billing_address = $14,
            public_email = $15,
            public_phone = $16,
            website = $17,
            representatives = $18::jsonb,
            privacy_contact = $19,
            dpo_contact = $20,
            licenses = $21::jsonb,
            brand = $22::jsonb,
            usage_settings = $23::jsonb,
            status = $24,
            approved_by_user_id = $25,
            approved_at = $26,
            updated_at = now()
          where id = $1
          returning
            id,
            profile_scope as "profileScope",
            workspace_id as "workspaceId",
            organization_id as "organizationId",
            legal_name as "legalName",
            display_name as "displayName",
            legal_form as "legalForm",
            country_code as "countryCode",
            jurisdiction,
            registration_number as "registrationNumber",
            registration_authority as "registrationAuthority",
            register_court as "registerCourt",
            vat_id as "vatId",
            tax_number as "taxNumber",
            registered_office_address as "registeredOfficeAddress",
            business_address as "businessAddress",
            billing_address as "billingAddress",
            public_email as "publicEmail",
            public_phone as "publicPhone",
            website,
            representatives,
            privacy_contact as "privacyContact",
            dpo_contact as "dpoContact",
            licenses,
            brand,
            usage_settings as "usageSettings",
            status,
            approved_by_user_id as "approvedByUserId",
            approved_at as "approvedAt",
            created_at as "createdAt",
            updated_at as "updatedAt"
        `,
        [
          existing.id,
          next.legalName,
          next.displayName,
          next.legalForm,
          next.countryCode,
          next.jurisdiction,
          next.registrationNumber,
          next.registrationAuthority,
          next.registerCourt,
          next.vatId,
          next.taxNumber,
          next.registeredOfficeAddress,
          next.businessAddress,
          next.billingAddress,
          next.publicEmail,
          next.publicPhone,
          next.website,
          JSON.stringify(next.representatives),
          next.privacyContact,
          next.dpoContact,
          JSON.stringify(next.licenses),
          JSON.stringify(next.brand),
          JSON.stringify(next.usageSettings),
          next.status,
          approvedByUserId,
          approvedAt,
        ],
      )
    : await queryOne<CompanyProfileRow>(
        `
          insert into company_profiles (
            profile_scope,
            workspace_id,
            organization_id,
            legal_name,
            display_name,
            legal_form,
            country_code,
            jurisdiction,
            registration_number,
            registration_authority,
            register_court,
            vat_id,
            tax_number,
            registered_office_address,
            business_address,
            billing_address,
            public_email,
            public_phone,
            website,
            representatives,
            privacy_contact,
            dpo_contact,
            licenses,
            brand,
            usage_settings,
            status,
            approved_by_user_id,
            approved_at
          )
          values (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            $19,
            $20::jsonb,
            $21,
            $22,
            $23::jsonb,
            $24::jsonb,
            $25::jsonb,
            $26,
            $27,
            $28
          )
          returning
            id,
            profile_scope as "profileScope",
            workspace_id as "workspaceId",
            organization_id as "organizationId",
            legal_name as "legalName",
            display_name as "displayName",
            legal_form as "legalForm",
            country_code as "countryCode",
            jurisdiction,
            registration_number as "registrationNumber",
            registration_authority as "registrationAuthority",
            register_court as "registerCourt",
            vat_id as "vatId",
            tax_number as "taxNumber",
            registered_office_address as "registeredOfficeAddress",
            business_address as "businessAddress",
            billing_address as "billingAddress",
            public_email as "publicEmail",
            public_phone as "publicPhone",
            website,
            representatives,
            privacy_contact as "privacyContact",
            dpo_contact as "dpoContact",
            licenses,
            brand,
            usage_settings as "usageSettings",
            status,
            approved_by_user_id as "approvedByUserId",
            approved_at as "approvedAt",
            created_at as "createdAt",
            updated_at as "updatedAt"
        `,
        [
          scope,
          scope === "platform_operator" ? null : input.session.workspaceId,
          scope === "crm_account" ? organizationId : null,
          next.legalName,
          next.displayName,
          next.legalForm,
          next.countryCode,
          next.jurisdiction,
          next.registrationNumber,
          next.registrationAuthority,
          next.registerCourt,
          next.vatId,
          next.taxNumber,
          next.registeredOfficeAddress,
          next.businessAddress,
          next.billingAddress,
          next.publicEmail,
          next.publicPhone,
          next.website,
          JSON.stringify(next.representatives),
          next.privacyContact,
          next.dpoContact,
          JSON.stringify(next.licenses),
          JSON.stringify(next.brand),
          JSON.stringify(next.usageSettings),
          next.status,
          approvedByUserId,
          approvedAt,
        ],
      );

  if (!row) return { ok: false as const, reason: "Company profile could not be saved", status: 500 };
  const profile = toProfile(row);

  await executeQuery(
    `
      insert into company_profile_versions (
        company_profile_id,
        workspace_id,
        actor_user_id,
        action,
        before,
        after,
        changed_fields
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[])
    `,
    [
      profile.id,
      profile.workspaceId ?? null,
      isUuid(input.session.userId) ? input.session.userId : null,
      existingRow ? "company_profile.updated" : "company_profile.created",
      JSON.stringify(existingRow ? existing : null),
      JSON.stringify(profile),
      changedFields,
    ],
  );

  await writeAuditLog({
    action: existingRow ? "company_profile.updated" : "company_profile.created",
    after: { changedFields, profile },
    before: existingRow ? existing : null,
    entityId: isUuid(profile.id) ? profile.id : null,
    entityType: "company_profile",
    session: input.session,
  });

  return {
    ok: true as const,
    payload: await getCompanyProfilePayload({ organizationId, profileScope: scope, session: input.session }),
  };
}
