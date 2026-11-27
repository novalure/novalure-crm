import { PropertyUploadError } from "@/lib/property-batch-upload";
import { preparePropertyImageUpload, PropertyHeicConversionError } from "@/lib/property-heic-browser";

/** Convert supported HEIC in the browser before any network write is attempted. */
export async function preparePropertyUploadFile(file: File, kind: "media" | "document" | "floorplan"): Promise<File> {
  if (kind === "document") return file;
  try {
    return await preparePropertyImageUpload(file);
  } catch (error) {
    // A known local conversion failure has no remote side effect; other files may continue.
    if (error instanceof PropertyHeicConversionError) throw new PropertyUploadError(error.message);
    throw error;
  }
}
