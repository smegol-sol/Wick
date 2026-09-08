/**
 * The two inputs the owner types for unseal and halt-clear, checked before a
 * request leaves the browser, and the one line the console shows when the
 * engine refuses. The engine is the authority; this only saves a round trip.
 */
import { ApiFailure } from "./api.ts";

/** Six digits, spaces tolerated; null otherwise. */
export function normalizeCode(raw: string): string | null {
  const digits = raw.replace(/\s+/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** Same bounds as the vault's `passOk` in core (10 to 128 characters). */
export function passphraseOk(p: string): boolean {
  return p.length >= 10 && p.length <= 128;
}

/** What to show under the form when a request fails. */
export function failureText(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.status === 409) return e.message || "the engine has no vault or no second factor";
    if (e.status === 403) return e.message || "refused";
    if (e.status === 401) return "the API token was rejected";
    return `${e.status}: ${e.message}`;
  }
  return e instanceof Error ? e.message : "request failed";
}
