/** Finish observed API traffic and its body inspection before destroying a document. */
export function createResponseInspectionBarrier() {
  const requests = new Map();
  const checks = new Set();
  return {
    started(request) {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      requests.set(request, { done, finish });
    },
    finished(request) {
      requests.get(request)?.finish();
      requests.delete(request);
    },
    inspect(check) {
      checks.add(check);
      // Observe both outcomes without hiding them from the caller's evidence.
      void check.then(() => checks.delete(check), () => checks.delete(check));
    },
    async drain(timeoutMs = 15_000) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Pending API/body inspection before navigation timed out")), timeoutMs);
      });
      try {
        while (requests.size || checks.size) {
          await Promise.race([
            Promise.allSettled([...requests.values()].map(row => row.done).concat([...checks])),
            timeout,
          ]);
        }
      } finally { clearTimeout(timer); }
    },
  };
}
