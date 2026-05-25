import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const passwordHashPrefix = "scrypt";
const passwordKeyLength = 64;

export const minimumPasswordLength = 12;

export type PasswordValidationError =
  | "password_mismatch"
  | "password_required"
  | "password_too_short";

export function getPasswordValidationError(password: string, confirmation: string): PasswordValidationError | null {
  if (!password || !confirmation) return "password_required";
  if (password.length < minimumPasswordLength) return "password_too_short";
  if (password !== confirmation) return "password_mismatch";
  return null;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = (await scrypt(password, salt, passwordKeyLength)) as Buffer;

  return [passwordHashPrefix, salt, derivedKey.toString("base64url")].join(":");
}

export async function verifyPassword(password: string, storedHash: string | null | undefined) {
  if (!password || !storedHash) return false;

  const [prefix, salt, key] = storedHash.split(":");
  if (prefix !== passwordHashPrefix || !salt || !key) return false;

  const expectedKey = Buffer.from(key, "base64url");
  const derivedKey = (await scrypt(password, salt, expectedKey.length)) as Buffer;

  return expectedKey.length === derivedKey.length && timingSafeEqual(expectedKey, derivedKey);
}
