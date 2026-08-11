export function protectAuthResponse<ResponseType extends Response>(
  response: ResponseType,
  options: { noReferrer?: boolean } = {},
) {
  response.headers.set("Cache-Control", "private, no-store");
  if (options.noReferrer) response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
