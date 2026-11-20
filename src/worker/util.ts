// Small, dependency-free helpers shared by the Worker and the Hub Durable Object.

const encoder = new TextEncoder();

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export function randomId(prefix: string, bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return `${prefix}_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64url(digest);
}

/** Constant-time string comparison (compares SHA-256 digests to equalise length). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export async function hmacSha256Base64(secret: Uint8Array<ArrayBuffer>, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  let s = "";
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return btoa(s);
}

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const RESERVED_HANDLES = new Set(["owner", "hub", "admin", "system"]);

export function slugifyHandle(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/**
 * An expected, user-facing error. Durable Object RPC only preserves an error's
 * message, so the code and HTTP status travel inside it as a `[code:status]`
 * prefix and are recovered with `describeError` on the Worker side.
 */
export class HubError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(`[${code}:${status}] ${message}`);
  }
}

export function describeError(e: unknown): { code: string; status: number; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /^\[([a-z_]+):(\d{3})\] ([\s\S]*)$/.exec(raw);
  if (m) return { code: m[1]!, status: Number(m[2]), message: m[3]! };
  return { code: "internal", status: 500, message: "Something went wrong on the hub." };
}

export function now(): number {
  return Date.now();
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
