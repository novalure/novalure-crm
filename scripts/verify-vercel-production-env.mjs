const requiredSensitiveProductionVariables = [
  "NOVALURE_ABUSE_SECRET",
  "NOVALURE_AUTH_ENCRYPTION_KEY",
  "NOVALURE_AUTH_RATE_LIMIT_SECRET",
  "NOVALURE_SESSION_SECRET",
  "OAUTH_STATE_SECRET",
  "OAUTH_TOKEN_ENCRYPTION_KEY",
];

function requiredEnvironmentValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const token = requiredEnvironmentValue("VERCEL_TOKEN");
const projectId = requiredEnvironmentValue("VERCEL_PROJECT_ID");
const teamId = requiredEnvironmentValue("VERCEL_TEAM_ID");
const endpoint = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env`);
endpoint.searchParams.set("teamId", teamId);

const response = await fetch(endpoint, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

if (!response.ok) {
  throw new Error(`Vercel environment metadata request failed with HTTP ${response.status}`);
}

const payload = await response.json();
const variables = Array.isArray(payload.envs) ? payload.envs : [];
const failures = [];

for (const key of requiredSensitiveProductionVariables) {
  const matches = variables.filter(
    (variable) => variable?.key === key && variable?.target?.includes("production"),
  );

  if (matches.length !== 1) {
    failures.push(`${key}: expected exactly one Production entry, found ${matches.length}`);
    continue;
  }

  if (matches[0]?.type !== "sensitive") {
    failures.push(`${key}: expected type sensitive, found ${matches[0]?.type ?? "unknown"}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`ERROR ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Vercel Production security environment preflight passed.");
  for (const key of requiredSensitiveProductionVariables) console.log(`OK ${key}`);
}
