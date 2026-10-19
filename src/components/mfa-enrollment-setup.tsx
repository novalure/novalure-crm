"use client";

import { useState } from "react";
import subpageStyles from "@/components/public-subpage.module.css";
import type { getLoginPageCopy } from "@/lib/i18n";

type MfaEnrollmentSetupProps = {
  qrCodeDataUrl: string | null;
  secret: string;
  copy: ReturnType<typeof getLoginPageCopy>["mfaSetup"];
};

export function MfaEnrollmentSetup({ qrCodeDataUrl, secret, copy }: MfaEnrollmentSetupProps) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copySecret() {
    try {
      if (!navigator.clipboard?.writeText) {
        setCopyStatus("failed");
        return;
      }

      await navigator.clipboard.writeText(secret);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <div className={subpageStyles.noticeStack}>
      <p className={subpageStyles.notice}>{copy.instructions}</p>
      {qrCodeDataUrl ? (
        <>
          {/* A local data URI keeps the enrollment secret away from image services. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={copy.qrAlt}
            height={256}
            src={qrCodeDataUrl}
            style={{ display: "block", height: "auto", margin: "0 auto", maxWidth: "100%" }}
            width={256}
          />
        </>
      ) : (
        <p className={subpageStyles.fieldHelp}>{copy.qrUnavailable}</p>
      )}
      <p className={subpageStyles.fieldHelp}>{copy.smartphoneHelp}</p>
      <details open={!qrCodeDataUrl}>
        <summary className={subpageStyles.textLink} style={{ cursor: "pointer" }}>
          {copy.manualToggle}
        </summary>
        <div className={subpageStyles.noticeStack}>
          <p className={subpageStyles.fieldHelp}>{copy.manualInstructions}</p>
          <p className={subpageStyles.fieldHelp}>
            <strong>{copy.manualKeyLabel}</strong>
            <code style={{ display: "block", overflowWrap: "anywhere", userSelect: "all" }}>{secret}</code>
          </p>
          <button className={subpageStyles.secondaryButton} onClick={copySecret} type="button">
            {copy.copyKey}
          </button>
          <p aria-live="polite" className={subpageStyles.fieldHelp} role="status">
            {copyStatus === "copied" ? copy.copySuccess : copyStatus === "failed" ? copy.copyFailure : ""}
          </p>
        </div>
      </details>
    </div>
  );
}
