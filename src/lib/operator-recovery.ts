import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import recipient from "../../config/operator-recovery-recipient.json";
import type { AppSession } from "./auth/session";

export const recoverySecretNames = ["NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_SESSION_SECRET", "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN"] as const;
export function isPinnedRecoveryOperator(session: AppSession) {
  return session.authenticated && session.source === "cookie" && !!session.authSessionId &&
    session.workspaceId === recipient.workspaceId && session.userId === recipient.operatorUserId &&
    session.authIdentityId === recipient.operatorAuthIdentityId && session.role === "admin" &&
    session.productRole === "novalureAdmin" && !!session.mfaVerifiedAt;
}

/** Only this fixed recipient and these four keys. No caller-controlled key, scope or environment selector. */
export function sealOperatorRecovery(env: NodeJS.ProcessEnv) {
  const publicKey = createPublicKey(recipient.publicKey);
  if (publicKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyDetails?.modulusLength !== 4096 ||
    createHash("sha256").update(recipient.publicKey).digest("hex") !== recipient.recipientSha256) throw new Error("RECOVERY_RECIPIENT_INVALID");
  const secrets = Object.fromEntries(recoverySecretNames.map(name => {
    const value = env[name]?.trim();
    if (!value || value.length < 32 || value.length > 8192) throw new Error("RECOVERY_CONFIGURATION_UNAVAILABLE");
    return [name, value];
  }));
  if (!secrets.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN.startsWith("vercel_blob_rw_")) throw new Error("RECOVERY_CONFIGURATION_UNAVAILABLE");
  const header = { format: "novalure-operator-recovery-v1", recipientSha256: recipient.recipientSha256,
    workspaceId: recipient.workspaceId, capturedAt: new Date().toISOString(), sourceRevision: env.VERCEL_GIT_COMMIT_SHA ?? "local" };
  const aad = Buffer.from(JSON.stringify(header));
  const key = randomBytes(32), iv = randomBytes(12);
  const plain = Buffer.from(JSON.stringify({ ...header, secrets }));
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { ...header, algorithm: "RSA-OAEP-SHA256+A256GCM", secretNames: [...recoverySecretNames],
      wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
      iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), aad: aad.toString("base64"), ciphertext: encrypted.toString("base64") };
  } finally { key.fill(0); plain.fill(0); }
}
