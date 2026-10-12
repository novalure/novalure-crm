export function qaRequestUrl(path, baseUrl) {
  const target = new URL(path, baseUrl);
  if (target.origin !== new URL(baseUrl).origin || target.username || target.password) {
    throw new Error("QA_CROSS_ORIGIN_REQUEST_DENIED");
  }
  return target;
}
