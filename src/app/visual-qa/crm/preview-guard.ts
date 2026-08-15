const visualQaBranch = "codex/go-live-remediation-2026-08-11";

export function isVisualQaDeployment() {
  return (
    process.env.VERCEL_ENV === "preview" &&
    process.env.VERCEL_GIT_COMMIT_REF === visualQaBranch
  );
}
