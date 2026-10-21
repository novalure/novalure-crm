import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Preserve the reviewed screenshot bytes as text. Sources and destinations are
// fixed; materialization does not select, capture or edit images.
const images = Object.freeze([
  Object.freeze({
    source: "docs/qa/crm-ux-i18n-images/approval-after-de.png.b64",
    destination: "docs/qa/crm-ux-i18n-images/approval-after-de.png",
    bytes: 45864,
    sha256: "a6146d10959630985390ed76706600480c115319019a04a3242fd2ff9a621f3f",
  }),
  Object.freeze({
    source: "docs/qa/crm-ux-i18n-images/approval-before-de.png.b64",
    destination: "docs/qa/crm-ux-i18n-images/approval-before-de.png",
    bytes: 45425,
    sha256: "500c1be3ea355ba9e44bd72268e482609e2ed0a5776f4901889b4a48c8c357d9",
  }),
  Object.freeze({
    source: "docs/qa/crm-ux-i18n-images/properties-after-en.png.b64",
    destination: "docs/qa/crm-ux-i18n-images/properties-after-en.png",
    bytes: 102454,
    sha256: "fb8f35b1267e79260566eb1c5e296d17a287200f2988e0422588d136789f4f00",
  }),
]);
const root = new URL("../", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function decodeCrmUxI18nImage(source, expectedBytes, expectedDigest) {
  const encoded = source.replace(/\s/g, "");
  assert.match(
    encoded,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "CRM_UX_IMAGE_BASE64_INVALID",
  );
  const bytes = Buffer.from(encoded, "base64");
  assert.equal(bytes.toString("base64"), encoded, "CRM_UX_IMAGE_BASE64_NONCANONICAL");
  assert.equal(bytes.length, expectedBytes, "CRM_UX_IMAGE_LENGTH_MISMATCH");
  assert.equal(digest(bytes), expectedDigest, "CRM_UX_IMAGE_DIGEST_MISMATCH");
  return bytes;
}

export async function materializeCrmUxI18nImages() {
  // Validate all three sources before writing any approved destination.
  const prepared = await Promise.all(images.map(async (image) => ({
    image,
    bytes: decodeCrmUxI18nImage(
      await readFile(new URL(image.source, root), "utf8"),
      image.bytes,
      image.sha256,
    ),
  })));
  await mkdir(new URL("docs/qa/crm-ux-i18n-images/", root), { recursive: true });
  for (const { image, bytes } of prepared) {
    const destination = new URL(image.destination, root);
    await writeFile(destination, bytes);
    assert.equal(
      (await readFile(destination)).equals(bytes),
      true,
      "CRM_UX_IMAGE_WRITE_READBACK_MISMATCH",
    );
  }
  return images.map(({ destination, bytes, sha256 }) => ({ destination, bytes, sha256 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log("CRM_UX_IMAGE_MATERIALIZATION_PASS " + JSON.stringify(await materializeCrmUxI18nImages()));
}
