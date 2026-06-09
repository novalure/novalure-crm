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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const formKey = url.searchParams.get("form") ?? "novalure-form";
  const copy = getFormCommandCenterCopy("de");
  const persisted = await getPublicWebsiteFormByKey(formKey).catch(() => null);
  if (!persisted?.form) {
    const variant = normalizeRequestedVariant(url.searchParams.get("variant"), "embed");
    return createEmbedScript({
      formId: formKey,
      html: renderUnavailableEmbedHtml(copy.publicPage),
      variant,
    });
  }

  const form = persisted.form;
  const variant = normalizeRequestedVariant(url.searchParams.get("variant"), form.variant);
  const origin = url.origin;
  const publicKey = form.id || formKey;
  const publicUrl = `${origin}${persisted.publicPath ?? `/forms/${encodeURIComponent(publicKey)}`}`;
  const runtimeCopy = { ...fallbackFormRuntimeCopy, ...copy.runtime };
  const formHtml = renderStaticFormHtml({
    action: `${origin}/api/forms/submissions`,
    copy: runtimeCopy,
    form: { ...form, variant },
    publicKey,
    returnTo: persisted.publicPath ?? `/forms/${encodeURIComponent(publicKey)}`,
    source: "website",
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
  variant,
}: {
  formId: string;
  html: string;
  variant: FormVariant;
}) {
  const script = `
(function () {
  var currentScript = document.currentScript;
  var formId = ${JSON.stringify(formId)};
  var variant = ${JSON.stringify(variant)};
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

    function setHiddenValue(formElement, name, value) {
      var input = formElement.querySelector("input[name='" + name + "']");
      if (input) input.value = value;
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
      updateConditionalFields();
    }

    function visibleRequiredControls(step) {
      return Array.prototype.slice.call(step.querySelectorAll("input, textarea, select")).filter(function (control) {
        return control.required && !control.closest(".novalure-hidden") && control.type !== "hidden";
      });
    }

    function validateStep(step) {
      var valid = true;
      visibleRequiredControls(step).forEach(function (control) {
        var field = control.closest("[data-field-id]");
        var groupName = control.name;
        var missing = control.type === "checkbox" || control.type === "radio"
          ? !form.querySelector("input[name='" + cssEscape(groupName) + "']:checked")
          : !control.value;
        if (missing) {
          valid = false;
          if (field) field.classList.add("border", "border-red-400", "bg-red-50");
        } else if (field) {
          field.classList.remove("border", "border-red-400", "bg-red-50");
        }
      });
      return valid;
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
        if (!steps[currentStep] || validateStep(steps[currentStep])) setStep(currentStep + 1);
      });
    }
    if (previous) {
      previous.addEventListener("click", function () {
        setStep(currentStep - 1);
      });
    }
    form.addEventListener("submit", function (event) {
      var firstInvalid = -1;
      steps.forEach(function (step, index) {
        if (!validateStep(step) && firstInvalid < 0) firstInvalid = index;
      });
      if (firstInvalid >= 0) {
        event.preventDefault();
        setStep(firstInvalid);
      }
    });
    setStep(0);
  }
})();`;

  return new Response(script, {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "application/javascript; charset=utf-8",
    },
  });
}

function renderUnavailableEmbedHtml(copy: ReturnType<typeof getFormCommandCenterCopy>["publicPage"]) {
  return `<style>${embeddedFormStyles}${embedShellStyles}</style><div class="novalure-embed novalure-publication"><p>${escapeHtml(copy.unavailableTitle)}</p><p>${escapeHtml(copy.unavailableDescription)}</p><p>${escapeHtml(copy.unavailableHint)}</p></div>`;
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
.novalure-publication{display:grid;gap:14px;justify-items:start;background:#fff;border:1px solid #d8e5f7;border-radius:14px;padding:18px;box-shadow:0 18px 45px rgba(15,23,42,.12);font-family:Arial,sans-serif;color:#08233f}
.novalure-publication p{margin:0;font-size:14px;font-weight:700;line-height:1.45}
.novalure-qr{width:180px;height:180px;border:1px solid #d8e5f7;border-radius:10px}
.novalure-modal{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(2,6,23,.55);padding:16px}
.novalure-modal[hidden]{display:none}
.novalure-modal-panel{width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto}
.novalure-modal-close{display:block;margin:0 0 10px auto;border:1px solid #b9cbe6;border-radius:9px;background:#fff;color:#08233f;font-weight:800;padding:9px 12px;cursor:pointer}
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
