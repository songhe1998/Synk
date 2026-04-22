function firstForwardedHeaderValue(value: string | null) {
  if (!value) {
    return null;
  }

  const first = value
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);

  return first || null;
}

export function getPublicRequestOrigin(request: Request) {
  const nextUrl = new URL(request.url);
  const forwardedHost = firstForwardedHeaderValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = firstForwardedHeaderValue(request.headers.get("x-forwarded-proto"));
  const host = forwardedHost ?? request.headers.get("host");

  if (!host) {
    return nextUrl.origin;
  }

  const protocol =
    forwardedProto ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

  return `${protocol}://${host}`;
}
