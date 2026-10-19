import "server-only";
import QRCode from "qrcode";

/** Encode the existing provisioning URI verbatim, entirely inside the app. */
export async function createMfaQrCodeDataUrl(provisioningUri: string): Promise<string | null> {
  try {
    const uri = new URL(provisioningUri);
    if (
      provisioningUri.length > 4_096 ||
      uri.protocol !== "otpauth:" ||
      uri.hostname !== "totp" ||
      !uri.searchParams.get("secret")
    ) return null;

    return await QRCode.toDataURL(provisioningUri, {
      errorCorrectionLevel: "M",
      margin: 4,
      width: 256,
      color: { dark: "#000000ff", light: "#ffffffff" },
    });
  } catch {
    // Keep manual setup available. Encoding errors must not log the URI/secret.
    return null;
  }
}
