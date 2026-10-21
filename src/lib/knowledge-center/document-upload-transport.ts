/** A provider retry must never leave the upload dialog busy indefinitely.
 * Abort with AbortError: the Blob SDK retries TimeoutError instead of bailing. */
export async function finalizeAfterPrivateDocumentUpload<Result>(
  upload: (signal: AbortSignal) => Promise<unknown>,
  finalize: () => Promise<Result>,
  timeoutMs = 60_000,
): Promise<Result> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Document upload timed out. Please retry."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => upload(controller.signal)), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // A late provider completion after timeout cannot attach a document.
  return finalize();
}
