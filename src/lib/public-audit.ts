export function getRequestCountry(requestHeaders: Headers) {
  return (
    requestHeaders.get("x-vercel-ip-country") ??
    requestHeaders.get("cf-ipcountry") ??
    requestHeaders.get("x-country-code")
  );
}
