export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function requireTrustedJsonMutation(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ControlPlaneError("JSON_CONTENT_TYPE_REQUIRED", 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    throw new ControlPlaneError("REQUEST_TOO_LARGE", 413);
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new ControlPlaneError("CROSS_SITE_MUTATION_BLOCKED", 403);
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new ControlPlaneError("ORIGIN_MISMATCH", 403);
  }
}

export function requireSafeIdentifier(
  value: string | null,
  name: string,
  maxLength = 160,
) {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new ControlPlaneError(name + "_REQUIRED", 400);
  if (normalized.length > maxLength) throw new ControlPlaneError(name + "_TOO_LONG", 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/ -]*$/.test(normalized)) {
    throw new ControlPlaneError(name + "_INVALID", 400);
  }
  return normalized;
}

export function noStoreJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return Response.json(body, { ...init, headers });
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "CONTROL_PLANE_ERROR";
  if (error instanceof ControlPlaneError) {
    return noStoreJson({ error: message }, { status: error.status });
  }
  if (message === "AUTHENTICATION_REQUIRED") {
    return noStoreJson({ error: message }, { status: 401 });
  }
  if (message.includes("AUTHORIZATION") || message.includes("ADAPTER_AUTHENTICATION")) {
    return noStoreJson({ error: "AUTHORIZATION_DENIED" }, { status: 403 });
  }
  if (message.endsWith("_NOT_FOUND")) {
    return noStoreJson({ error: message }, { status: 404 });
  }
  if (message.includes("no such table")) {
    return noStoreJson({ error: "CONTROL_PLANE_NOT_INITIALIZED" }, { status: 503 });
  }
  return noStoreJson({ error: "CONTROL_PLANE_ERROR" }, { status: 500 });
}
