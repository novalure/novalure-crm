import assert from "node:assert/strict";

export function requireTrustedShareLanding(pageUrl, previewOrigin) {
  const landingOrigin = new URL(pageUrl).origin;
  assert.ok(
    landingOrigin === previewOrigin || landingOrigin === "https://vercel.com",
    "Share access left the exact Preview/Vercel trust boundary.",
  );
  return landingOrigin;
}

export async function requirePreviewApplicationLanding({ page, previewOrigin, response }) {
  const status = response?.status?.();
  assert.ok(
    Number.isInteger(status) && status >= 200 && status < 400,
    "Share cookie did not return a successful Preview response.",
  );
  assert.equal(
    new URL(page.url()).origin,
    previewOrigin,
    "Share cookie did not grant access to the exact Preview origin.",
  );
  await page.waitForSelector("[data-public-language]", { timeout: 10_000, visible: true });
  assert.equal(
    new URL(page.url()).origin,
    previewOrigin,
    "Preview application marker resolved outside the exact Preview origin.",
  );
}

export function createBrowserRuntimeCleanup({
  getBrowser,
  killOrphanedBrowsers,
  profileDirectory,
  removeDirectory,
}) {
  let cleanupPromise;
  return function cleanupBrowserRuntime() {
    cleanupPromise ??= (async () => {
      const errors = [];
      let browser = null;
      try {
        browser = await getBrowser();
      } catch (error) {
        errors.push(error);
      }
      if (browser) {
        try {
          await browser.kill();
        } catch (error) {
          errors.push(error);
        }
      } else if (killOrphanedBrowsers) {
        try {
          const orphanErrors = await killOrphanedBrowsers();
          if (Array.isArray(orphanErrors)) errors.push(...orphanErrors);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await removeDirectory(profileDirectory, {
          force: true,
          maxRetries: 30,
          recursive: true,
          retryDelay: 100,
        });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Chrome shutdown and secret-profile cleanup both failed.");
      }
    })();
    return cleanupPromise;
  };
}

export async function settleRunWithCleanup(primaryError, cleanup) {
  let cleanupError = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Lighthouse execution and secret-profile cleanup both failed.",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

export function installTerminationCleanup(cleanup, {
  logger = console,
  processObject = process,
} = {}) {
  let terminationStarted = false;
  const handlers = new Map();
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const handler = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      void cleanup().then(
        () => processObject.exit(exitCode),
        (error) => {
          logger.error("Lighthouse browser cleanup failed during termination.", error);
          processObject.exit(1);
        },
      );
    };
    handlers.set(signal, handler);
    processObject.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) processObject.off(signal, handler);
  };
}
