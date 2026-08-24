/**
 * Security-owner handoff boundary. A real Ed25519 root public key must replace
 * these nulls in a reviewed Candidate commit before Production activation can
 * ever succeed. No private key belongs in this repository or Vercel.
 */
export const launchActivationPinnedRoot = Object.freeze({
  algorithm: "Ed25519" as const,
  keyId: null,
  minimumAnchorGeneration: 1,
  publicKeyPem: null,
  publicKeySha256: null,
  status: "PENDING_SECURITY_OWNER_KEY" as const,
});

/**
 * The trust root above stays pending until Security supplies its public key.
 * The Flags environment itself is independently pinned in
 * `launch-activation-flag.server.ts`; it is never taken from an environment
 * variable or accepted merely because a receipt repeats it.
 */
