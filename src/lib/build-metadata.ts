import "server-only";

const shaPattern = /^[a-f0-9]{40}$/;

function known(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized !== "unknown" ? normalized : null;
}

export function getBuildMetadata() {
  const gitSha = known(process.env.NOVALURE_BUILD_GIT_SHA);
  return {
    applicationVersion: known(process.env.NOVALURE_APPLICATION_VERSION),
    branch: known(process.env.NOVALURE_BUILD_GIT_BRANCH),
    buildTimestamp: known(process.env.NOVALURE_BUILD_TIMESTAMP),
    deploymentId: known(process.env.NOVALURE_BUILD_DEPLOYMENT_ID ?? process.env.VERCEL_DEPLOYMENT_ID),
    gitSha: gitSha && shaPattern.test(gitSha) ? gitSha : null,
  };
}
