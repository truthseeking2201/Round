// Maximum request body size (1MB)
const MAX_BODY_SIZE = 1024 * 1024;

// Allowed origins for CORS (set via env or defaults)
function normalizeOrigin(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

function getAllowedOrigins(): string[] {
  const envOrigins = Deno.env.get("CORS_ALLOWED_ORIGINS");
  if (envOrigins) {
    const out: string[] = [];
    for (const raw of envOrigins.split(",")) {
      const n = normalizeOrigin(raw);
      if (n) out.push(n);
    }
    return Array.from(new Set(out));
  }
  // Default: Telegram WebApp domains + localhost for dev
  return Array.from(
    new Set(
      [
        "https://web.telegram.org",
        "https://t.me",
        "http://localhost:5173",
        "http://localhost:3000",
      ]
        .map((o) => normalizeOrigin(o))
        .filter((v): v is string => Boolean(v))
    )
  );
}

export function getCorsHeaders(origin?: string | null): Record<string, string> {
  const allowedOrigins = getAllowedOrigins();

  // Check if origin is allowed (or wildcard for dev if CORS_ALLOW_ALL=true)
  const allowAll = Deno.env.get("CORS_ALLOW_ALL") === "true";
  const normalized = origin ? normalizeOrigin(origin) : null;
  const isAllowed = allowAll || (normalized ? allowedOrigins.includes(normalized) : false);

  const allowOrigin = isAllowed ? (normalized ?? "*") : allowedOrigins[0] ?? "*";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-max-age": "86400",
    // Important for caches/CDNs when allow-origin is dynamic.
    vary: "origin",
  };
}

// Legacy export for backward compatibility (uses first allowed origin)
export const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": getAllowedOrigins()[0] ?? "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

export function withCors(response: Response, origin?: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(getCorsHeaders(origin))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function jsonResponse(body: unknown, status = 200, origin?: string | null): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    origin
  );
}

export function errorResponse(code: string, status: number, message?: string, origin?: string | null): Response {
  // Sanitize: never expose raw DB/system errors to client
  const safeMessage = sanitizeErrorMessage(message ?? code);
  return jsonResponse({ error: { code, message: safeMessage } }, status, origin);
}

// Sanitize error messages to prevent leaking sensitive info
function sanitizeErrorMessage(message: string): string {
  // List of patterns that should not be exposed
  const sensitivePatterns = [
    /duplicate key value/i,
    /violates unique constraint/i,
    /violates foreign key/i,
    /relation .+ does not exist/i,
    /column .+ does not exist/i,
    /syntax error/i,
    /permission denied/i,
    /authentication failed/i,
    /password/i,
    /secret/i,
    /token/i,
    /key/i,
    /postgres/i,
    /supabase/i,
    /sql/i,
  ];

  const lowerMessage = message.toLowerCase();
  for (const pattern of sensitivePatterns) {
    if (pattern.test(lowerMessage)) {
      // Log the real error server-side
      console.error("[SANITIZED_ERROR]", message);
      return "An error occurred. Please try again.";
    }
  }

  return message;
}

export async function readJson<T>(req: Request): Promise<T> {
  // Check Content-Length if provided
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const len = Number(contentLength);
    if (len > MAX_BODY_SIZE) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
  }

  // Read with size limit
  const reader = req.body?.getReader();
  if (!reader) {
    throw new Error("INVALID_JSON");
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_BODY_SIZE) {
        reader.cancel();
        throw new Error("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const allBytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    allBytes.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder().decode(allBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("INVALID_JSON");
  }
}
