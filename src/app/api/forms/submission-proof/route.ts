import { getPublicWebsiteFormByKey } from "@/lib/db/form-repositories";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { getPublicFormLaunchBlockReason } from "@/lib/public-form-dto";
import { publicSubmissionControlFields } from "@/lib/public-submission-contract";
import {
  buildPublicSubmissionScope,
  buildVersionedPublicSubmissionResourceId,
  getPublicSubmissionProof,
  publicSubmissionActions,
  publicSubmissionProofRefreshGraceSeconds,
  publicSubmissionProofTtlSeconds,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionFormData,
  refreshPublicSubmissionProof,
  validatePublicSubmissionFieldRules,
} from "@/lib/security/public-submission-abuse";

const proofRefreshBodyLimits = {
  allowedFileBytes: 0,
  allowedFiles: 0,
  maxBodyBytes: 4_096,
  maxFieldNameLength: 128,
  maxFields: 8,
  maxStringLength: 512,
};

const proofRefreshHeaders = {
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { headers: proofRefreshHeaders, status });
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function OPTIONS() {
  return new Response(null, { headers: proofRefreshHeaders, status: 204 });
}

export async function POST(request: Request) {
  const launchScope = evaluateLaunchScope("publicFormProofRefresh");
  if (!launchScope.allowed) {
    return json({ code: launchScope.code, error: "submission_proof_refresh_launch_off" }, 503);
  }

  let formData: FormData;
  try {
    const parsed = await readBoundedPublicSubmissionFormData(request, proofRefreshBodyLimits);
    formData = parsed.formData;
    validatePublicSubmissionFieldRules(formData, [
      { maxLength: 512, name: "form" },
      { maxLength: 128, name: publicSubmissionControlFields.idempotencyKey },
      { maxLength: 20, name: publicSubmissionControlFields.issuedAt },
      { maxLength: 20, name: publicSubmissionControlFields.expiresAt },
      { maxLength: 128, name: publicSubmissionControlFields.proof },
    ]);
  } catch (error) {
    if (error instanceof PublicSubmissionRequestError) {
      return json({ error: error.code }, error.status);
    }
    return json({ error: "submission_proof_refresh_unavailable" }, 503);
  }

  const formKey = getString(formData, "form");
  if (!formKey || formKey.length > 512 || /[\r\n\u0000]/u.test(formKey)) {
    return json({ error: "invalid_form_key" }, 400);
  }

  let lookup: Awaited<ReturnType<typeof getPublicWebsiteFormByKey>>;
  try {
    lookup = await getPublicWebsiteFormByKey(formKey);
  } catch {
    return json({ error: "submission_proof_refresh_unavailable" }, 503);
  }
  if (!lookup) return json({ error: "form_not_found" }, 404);

  const launchBlockReason = getPublicFormLaunchBlockReason(lookup.form, lookup.ownerActive);
  if (launchBlockReason) return json({ error: launchBlockReason }, 503);

  try {
    const refreshed = refreshPublicSubmissionProof({
      action: publicSubmissionActions.form,
      proof: getPublicSubmissionProof(formData),
      scope: buildPublicSubmissionScope({
        resourceId: buildVersionedPublicSubmissionResourceId({
          resourceId: lookup.id,
          version: lookup.form.version,
        }),
        resourceType: "form",
        workspaceId: lookup.workspaceId,
      }),
    });
    if (!refreshed.ok) return json({ error: refreshed.reason }, 400);

    return json({
      proof: refreshed.proof,
      refreshGraceSeconds: publicSubmissionProofRefreshGraceSeconds,
      ttlSeconds: publicSubmissionProofTtlSeconds,
    });
  } catch {
    return json({ error: "submission_proof_refresh_unavailable" }, 503);
  }
}
