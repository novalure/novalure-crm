const visualQaBranch = "codex/justimmo-inspired-improvements-20260902";

export function isVisualQaDeployment() {
  return (
    process.env.VERCEL_ENV === "preview" &&
    process.env.VERCEL_GIT_COMMIT_REF === visualQaBranch
  );
}
