import {
  embeddedFormStyles,
  fallbackFormRuntimeCopy,
} from "@/components/form-renderer";
import { renderStaticFormHtml } from "@/components/form-renderer-static";
import { getPublicWebsiteFormByKey } from "@/lib/db/form-repositories";
import {
  resolveRuntimeLayoutVariant,
  type FormVariant,
} from "@/lib/form-types";
import { getFormCommandCenterCopy } from "@/lib/i18n";
import {
  getPublicFormLaunchBlockReason,
  toPublicFormDto,
  type PublicFormLaunchBlockReason,
} from "@/lib/public-form-dto";
import {
  publicSubmissionControlFields,
  publicSubmissionProofRefreshLeadSeconds,
} from "@/lib/public-submission-contract";
import {
  buildPublicSubmissionScope,
  buildVersionedPublicSubmissionResourceId,
  createPublicSubmissionProof,
  publicSubmissionActions,
} from "@/lib/security/public-submission-abuse";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const formKey = url.searchParams.get("form") ?? "novalure-form";
  const copy = getFormCommandCenterCopy("de");
  let persisted: Awaited<ReturnType<typeof getPublicWebsiteFormByKey>>;
  try {
    persisted = await getPublicWebsiteFormByKey(formKey);
  } catch {
    const variant = normalizeRequestedVariant(url.searchParams.get("variant"), "embed");
    return createEmbedScript({
      formId: formKey,
      html: renderUnavailableEmbedHtml(copy.publicPage),
      status: 503,
      variant,
    });
  }
  if (!persisted?.form) {
    const variant = normalizeRequestedVariant(url.searchParams.get("variant"), "embed");
    return createEmbedScript({
      formId: formKey,
      html: renderUnavailableEmbedHtml(copy.publicPage),
      status: 404,
      variant,
    });
  }

  const form = persisted.form;
  const variant = normalizeRequestedVariant(url.searchParams.get("variant"), form.variant);
  const launchBlockReason = getPublicFormLaunchBlockReason(form, persisted.ownerActive);
  if (launchBlockReason) {
    return createEmbedScript({
      formId: formKey,
      html: renderUnavailableEmbedHtml(copy.publicPage, launchBlockReason),
      variant,
    });
  }
  const origin = url.origin;
  const publicKey = form.id || formKey;
  const publicUrl = `${origin}${persisted.publicPath ?? `/forms/${encodeURIComponent(publicKey)}`}`;
  const runtimeCopy = { ...fallbackFormRuntimeCopy, ...copy.runtime };
  const submissionProof = createPublicSubmissionProof({
    action: publicSubmissionActions.form,
    scope: buildPublicSubmissionScope({
      resourceId: buildVersionedPublicSubmissionResourceId({
        resourceId: persisted.id,
        version: form.version,
      }),
      resourceType: "form",
      workspaceId: persisted.workspaceId,
    }),
  });
  const formHtml = renderStaticFormHtml({
    action: `${origin}/api/forms/submissions`,
    copy: runtimeCopy,
    form: toPublicFormDto(form),
    proofRefreshUrl: `${origin}/api/forms/submission-proof`,
    publicKey,
    returnTo: persisted.publicPath ?? `/forms/${encodeURIComponent(publicKey)}`,
    source: "website",
    submissionProof,
  });
  const html = renderEmbedHtml({
    copy: copy.runtime,
    formHtml,
    layoutVariant: resolveRuntimeLayoutVariant(variant),
    publicUrl,
    variant,
  });

  return createEmbedScript({
    formId: publicKey,
    html,
    variant,
  });
}

function createEmbedScript({
  formId,
  html,
  status = 200,
  variant,
}: {
  formId: string;
  html: string;
  status?: number;
  variant: FormVariant;
}) {
  const script = `
(function () {
  var currentScript = document.currentScript;
  var formId = ${JSON.stringify(formId)};
  var variant = ${JSON.stringify(variant)};
  var proofFields = ${JSON.stringify(publicSubmissionControlFields)};
  var proofRefreshLeadSeconds = ${publicSubmissionProofRefreshLeadSeconds};
  var host = currentScript && currentScript.parentElement ? currentScript.parentElement : document.body;
  var container = document.createElement("div");
  container.setAttribute("data-novalure-form", formId);
  container.setAttribute("data-novalure-variant", variant);
  container.innerHTML = ${JSON.stringify(html)};
  host.appendChild(container);
  setupNovalureForm(container);

  function setupNovalureForm(root) {
    var modal = root.querySelector("[data-novalure-modal]");
    var openButton = root.querySelector("[data-novalure-open]");
    var closeButton = root.querySelector("[data-novalure-close]");
    if (openButton && modal) {
      openButton.addEventListener("click", function () {
        modal.removeAttribute("hidden");
      });
    }
    if (closeButton && modal) {
      closeButton.addEventListener("click", function () {
        modal.setAttribute("hidden", "hidden");
      });
    }

    var form = root.querySelector("[data-novalure-runtime='form']");
    if (!form) return;
    setHiddenValue(form, "page_url", window.location.href);
    setHiddenValue(form, "referrer", document.referrer || "");
    var steps = Array.prototype.slice.call(form.querySelectorAll("[data-step-index]"));
    var currentStep = 0;
    var proofRefreshPromise = null;
    var proofRefreshTimer = null;

    function setHiddenValue(formElement, name, value) {
      var input = formElement.querySelector("input[name='" + name + "']");
      if (input) input.value = value;
    }

    function getHiddenValue(formElement, name) {
      var input = formElement.querySelector("input[name='" + name + "']");
      return input ? input.value : "";
    }

    function setProofRefreshError(visible) {
      var error = form.querySelector("[data-novalure-proof-refresh-error]");
      if (error) error.toggleAttribute("hidden", !visible);
    }

    function proofNeedsRefresh() {
      var expiresAt = Number(getHiddenValue(form, proofFields.expiresAt));
      return !Number.isFinite(expiresAt) ||
        expiresAt - proofRefreshLeadSeconds <= Math.floor(Date.now() / 1000);
    }

    function scheduleProofRefresh() {
      if (proofRefreshTimer) window.clearTimeout(proofRefreshTimer);
      var expiresAt = Number(getHiddenValue(form, proofFields.expiresAt));
      if (!Number.isFinite(expiresAt)) return;
      var refreshAt = (expiresAt - proofRefreshLeadSeconds) * 1000;
      var delay = Math.max(0, Math.min(2147483647, refreshAt - Date.now()));
      proofRefreshTimer = window.setTimeout(function () {
        refreshProof().catch(function () {});
      }, delay);
    }

    function installProof(proof, expectedIdempotencyKey) {
      if (!proof || typeof proof !== "object" ||
        proof.idempotencyKey !== expectedIdempotencyKey ||
        !Number.isSafeInteger(proof.issuedAt) ||
        !Number.isSafeInteger(proof.expiresAt) ||
        typeof proof.signature !== "string") {
        throw new Error("submission_proof_refresh_invalid");
      }
      setHiddenValue(form, proofFields.idempotencyKey, proof.idempotencyKey);
      setHiddenValue(form, proofFields.issuedAt, String(proof.issuedAt));
      setHiddenValue(form, proofFields.expiresAt, String(proof.expiresAt));
      setHiddenValue(form, proofFields.proof, proof.signature);
      setProofRefreshError(false);
      scheduleProofRefresh();
      return proof;
    }

    function refreshProof() {
      if (proofRefreshPromise) return proofRefreshPromise;
      var refreshUrl = form.getAttribute("data-novalure-proof-refresh-url");
      var idempotencyKey = getHiddenValue(form, proofFields.idempotencyKey);
      if (!refreshUrl || !idempotencyKey) {
        return Promise.reject(new Error("submission_proof_refresh_unavailable"));
      }
      var body = new URLSearchParams();
      body.set("form", formId);
      body.set(proofFields.idempotencyKey, idempotencyKey);
      body.set(proofFields.issuedAt, getHiddenValue(form, proofFields.issuedAt));
      body.set(proofFields.expiresAt, getHiddenValue(form, proofFields.expiresAt));
      body.set(proofFields.proof, getHiddenValue(form, proofFields.proof));
      proofRefreshPromise = fetch(refreshUrl, {
        body: body,
        cache: "no-store",
        credentials: "omit",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
        },
        method: "POST",
        mode: "cors"
      }).then(function (response) {
        if (!response.ok) throw new Error("submission_proof_refresh_failed");
        return response.json();
      }).then(function (payload) {
        return installProof(payload && payload.proof, idempotencyKey);
      }).finally(function () {
        proofRefreshPromise = null;
      });
      return proofRefreshPromise;
    }

    function getFieldValue(fieldId) {
      var field = form.querySelector("[data-field-id='" + cssEscape(fieldId) + "']");
      if (!field) return "";
      var controls = Array.prototype.slice.call(field.querySelectorAll("input, textarea, select"));
      var checked = controls.filter(function (control) { return control.checked; }).map(function (control) { return control.value; });
      if (checked.length) return checked.join(",");
      var control = controls[0];
      return control ? control.value : "";
    }

    function updateConditionalFields() {
      Array.prototype.slice.call(form.querySelectorAll("[data-condition-field]")).forEach(function (field) {
        var controller = field.getAttribute("data-condition-field");
        var expected = field.getAttribute("data-condition-value");
        var visible = !controller || !expected || getFieldValue(controller).split(",").indexOf(expected) >= 0 || getFieldValue(controller) === expected;
        field.classList.toggle("novalure-hidden", !visible);
        field.toggleAttribute("hidden", !visible);
        Array.prototype.slice.call(field.querySelectorAll("input, textarea, select")).forEach(function (control) {
          if (!control.hasAttribute("data-novalure-required")) {
            control.setAttribute("data-novalure-required", control.required ? "true" : "false");
          }
          control.disabled = !visible;
          control.required = visible && control.getAttribute("data-novalure-required") === "true";
        });
      });
    }

    function setStep(index) {
      currentStep = Math.max(0, Math.min(index, steps.length - 1));
      steps.forEach(function (step, stepIndex) {
        var active = stepIndex === currentStep;
        step.classList.toggle("novalure-hidden", !active);
        step.toggleAttribute("hidden", !active);
      });
      var previous = form.querySelector("[data-action='previous']");
      if (previous) previous.disabled = currentStep === 0;
      var next = form.querySelector("[data-action='next']");
      var submit = form.querySelector("[data-action='submit']");
      var onLastStep = currentStep === steps.length - 1;
      if (next) {
        next.classList.toggle("novalure-hidden", onLastStep);
        next.toggleAttribute("hidden", onLastStep);
      }
      if (submit) {
        submit.classList.toggle("novalure-hidden", !onLastStep);
        submit.toggleAttribute("hidden", !onLastStep);
      }
      updateConditionalFields();
    }

    function visibleStepControls(step) {
      return Array.prototype.slice.call(step.querySelectorAll("input, textarea, select")).filter(function (control) {
        var field = control.closest("[data-field-id]");
        var conditionallyHidden = field && (field.hidden || field.classList.contains("novalure-hidden"));
        return !control.disabled && control.type !== "hidden" && !conditionallyHidden && control.willValidate;
      });
    }

    function validateStep(step, shouldReport) {
      var firstInvalid = null;
      var invalidFields = [];
      var fields = Array.prototype.slice.call(step.querySelectorAll("[data-field-id]"));
      visibleStepControls(step).forEach(function (control) {
        var field = control.closest("[data-field-id]");
        if (!control.checkValidity()) {
          if (!firstInvalid) firstInvalid = control;
          if (field && invalidFields.indexOf(field) < 0) invalidFields.push(field);
        }
      });
      fields.forEach(function (field) {
        if (invalidFields.indexOf(field) >= 0) {
          field.classList.add("border", "border-red-400", "bg-red-50");
        } else {
          field.classList.remove("border", "border-red-400", "bg-red-50");
        }
      });
      if (shouldReport && firstInvalid) firstInvalid.reportValidity();
      return !firstInvalid;
    }

    function cssEscape(value) {
      if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
      return String(value).replace(/['"\\\\]/g, "\\\\$&");
    }

    form.addEventListener("input", updateConditionalFields);
    form.addEventListener("change", updateConditionalFields);
    var next = form.querySelector("[data-action='next']");
    var previous = form.querySelector("[data-action='previous']");
    if (next) {
      next.addEventListener("click", function () {
        if (!steps[currentStep] || validateStep(steps[currentStep], true)) setStep(currentStep + 1);
      });
    }
    if (previous) {
      previous.addEventListener("click", function () {
        setStep(currentStep - 1);
      });
    }
    form.addEventListener("submit", function (event) {
      updateConditionalFields();
      var firstInvalid = -1;
      steps.forEach(function (step, index) {
        if (!validateStep(step, false) && firstInvalid < 0) firstInvalid = index;
      });
      if (firstInvalid >= 0) {
        event.preventDefault();
        setStep(firstInvalid);
        validateStep(steps[firstInvalid], true);
        return;
      }
      if (!proofNeedsRefresh()) return;
      event.preventDefault();
      setProofRefreshError(false);
      refreshProof().then(function () {
        form.requestSubmit();
      }).catch(function () {
        setProofRefreshError(true);
      });
    });
    setStep(0);
    scheduleProofRefresh();
  }
})();`;

  return new Response(script, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/javascript; charset=utf-8",
    },
    status,
  });
}

function renderUnavailableEmbedHtml(
  copy: ReturnType<typeof getFormCommandCenterCopy>["publicPage"],
  reason?: PublicFormLaunchBlockReason,
) {
  const title = reason === "form_file_upload_unavailable"
    ? copy.fileUploadUnavailableTitle
    : reason === "form_custom_pattern_unavailable" || reason === "form_consent_configuration_unavailable"
      ? copy.configurationUnavailableTitle
    : reason === "form_round_robin_unavailable"
      ? copy.ownerUnavailableTitle
      : copy.unavailableTitle;
  const description = reason === "form_file_upload_unavailable"
    ? copy.fileUploadUnavailableDescription
    : reason === "form_custom_pattern_unavailable" || reason === "form_consent_configuration_unavailable"
      ? copy.configurationUnavailableDescription
    : reason === "form_round_robin_unavailable"
      ? copy.ownerUnavailableDescription
      : copy.unavailableDescription;
  return `<style>${embeddedFormStyles}${embedShellStyles}</style><div class="novalure-embed novalure-publication"><p>${escapeHtml(title)}</p><p>${escapeHtml(description)}</p><p>${escapeHtml(copy.unavailableHint)}</p></div>`;
}

function renderEmbedHtml({
  copy,
  formHtml,
  layoutVariant,
  publicUrl,
  variant,
}: {
  copy: ReturnType<typeof getFormCommandCenterCopy>["runtime"];
  formHtml: string;
  layoutVariant: ReturnType<typeof resolveRuntimeLayoutVariant>;
  publicUrl: string;
  variant: FormVariant;
}) {
  const styles = `<style>${embeddedFormStyles}${embedShellStyles}</style>`;

  if (variant === "standalone") {
    return `${styles}<div class="novalure-embed novalure-publication"><p>${escapeHtml(copy.standaloneCta)}</p><a class="novalure-button" href="${escapeHtml(publicUrl)}" target="_blank" rel="noreferrer">${escapeHtml(copy.standaloneCta)}</a></div>`;
  }

  if (variant === "qr") {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(publicUrl)}`;
    return `${styles}<div class="novalure-embed novalure-publication"><p>${escapeHtml(copy.qrDescription)}</p><img alt="QR-Code" class="novalure-qr" src="${escapeHtml(qrUrl)}"><a class="novalure-button" href="${escapeHtml(publicUrl)}" target="_blank" rel="noreferrer">${escapeHtml(copy.standaloneCta)}</a></div>`;
  }

  if (variant === "button") {
    return `${styles}<div class="novalure-embed"><button class="novalure-button" data-novalure-open type="button">${escapeHtml(copy.openForm)}</button><div class="novalure-modal" data-novalure-modal hidden><div class="novalure-modal-panel"><button class="novalure-modal-close" data-novalure-close type="button">${escapeHtml(copy.closeForm)}</button>${formHtml}</div></div></div>`;
  }

  return `${styles}<div class="novalure-embed novalure-embed-${layoutVariant}">${formHtml}</div>`;
}

const embedShellStyles = `
.novalure-embed{box-sizing:border-box;max-width:560px;margin:24px auto;padding:0}
.novalure-embed *{box-sizing:border-box}
.novalure-embed-popup{position:fixed;right:24px;bottom:24px;z-index:9999;width:min(560px,calc(100vw - 32px));margin:0}
.novalure-embed-slideIn{position:fixed;right:16px;top:96px;z-index:9999;width:min(560px,calc(100vw - 32px));margin:0}
.novalure-embed-stickyTop,.novalure-embed-stickyBottom{position:fixed;left:16px;right:16px;z-index:9999;max-width:none;margin:0}
.novalure-embed-stickyTop{top:16px}
.novalure-embed-stickyBottom{bottom:16px}
.novalure-publication{display:grid;gap:14px;justify-items:start;background:#fff;border:1px solid #e3ded5;border-radius:8px;padding:18px;box-shadow:0 18px 60px rgba(51,48,43,.08);font-family:Figtree,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#33302b}
.novalure-publication p{margin:0;font-size:14px;font-weight:700;line-height:1.45}
.novalure-qr{width:180px;height:180px;border:1px solid #e3ded5;border-radius:8px}
.novalure-modal{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(51,48,43,.62);padding:16px;backdrop-filter:blur(5px)}
.novalure-modal[hidden]{display:none}
.novalure-modal-panel{width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto}
.novalure-modal-close{display:block;min-height:44px;margin:0 0 10px auto;border:1px solid #e3ded5;border-radius:999px;background:#fff;color:#33302b;font-weight:850;padding:9px 16px;cursor:pointer}
@media (max-width:640px){.novalure-embed-popup,.novalure-embed-slideIn,.novalure-embed-stickyTop,.novalure-embed-stickyBottom{left:10px;right:10px;top:auto;bottom:10px;width:auto}}
`;

function normalizeRequestedVariant(value: string | null, fallback: FormVariant): FormVariant {
  return value === "button" ||
    value === "embed" ||
    value === "popup" ||
    value === "qr" ||
    value === "slideIn" ||
    value === "standalone" ||
    value === "stickyBottom" ||
    value === "stickyTop"
    ? value
    : fallback;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
