/**
 * Every failure in the image pipeline is an ImageError with a short machine-readable `code`
 * (shown in logs as "[IMAGE ERROR] <message>") so the CLI, review screen and API can react to it.
 */
export class ImageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ImageError";
    this.code = code;
    this.details = details;
  }
}

/** Map any thrown error (OpenAI SDK, network, ours) to a short, secret-free code + message. */
export function classifyError(err) {
  if (err instanceof ImageError) return { code: err.code, message: err.message };
  const status = err?.status;
  if (status === 429) return { code: "API_RATE_LIMIT", message: "OpenAI rate limit or quota reached (HTTP 429)" };
  if (status === 401) return { code: "API_AUTH", message: "OpenAI rejected the API key (HTTP 401)" };
  if (status === 403) return { code: "API_FORBIDDEN", message: "OpenAI denied access to this model (HTTP 403) — check the organisation is verified for image models" };
  if (status === 400) return { code: "API_BAD_REQUEST", message: `OpenAI rejected the request: ${err.message}` };
  if (status >= 500) return { code: "API_SERVER_ERROR", message: `OpenAI server error (HTTP ${status})` };
  if (err?.name === "APIConnectionTimeoutError" || /timed? ?out/i.test(err?.message ?? "")) return { code: "API_TIMEOUT", message: "OpenAI request timed out" };
  if (err?.name === "APIConnectionError") return { code: "API_CONNECTION", message: "Could not reach OpenAI (network problem)" };
  return { code: "UNEXPECTED", message: err?.message ?? String(err) };
}
