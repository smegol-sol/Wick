/** JSON lines on stdout. No token address, wallet or signature in `msg`; put them in `data`. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

/**
 * A warn or error line that repeats faster than this is dropped for the rest of its minute and
 * counted; the next minute opens with one line saying how many were dropped. A failure storm
 * (the RPC-cut drill on 2026-09-13 wrote some 300,000 lines in its window, and rotation then
 * evicted the boot lines) becomes a handful of lines with a count instead of a flood.
 */
const REPEAT_CAP_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const repeats = new Map<string, { windowStart: number; count: number; dropped: number }>();
let repeatCap = REPEAT_CAP_PER_MINUTE;

/** Tests only. */
export function setRepeatCap(cap: number): void {
  repeatCap = cap;
  repeats.clear();
}

/** True when the line may go out; a dropped line is counted against its (level, component, msg). */
function admit(level: Level, component: string, msg: string, now: number): boolean {
  if (level !== "warn" && level !== "error") return true;
  const key = `${level}|${component}|${msg}`;
  const r = repeats.get(key);
  if (!r || now - r.windowStart >= WINDOW_MS) {
    if (r && r.dropped > 0)
      write(
        "warn",
        JSON.stringify({
          ts: new Date(now).toISOString(),
          level: "warn",
          component,
          msg: "repeated line dropped",
          data: { of: msg, dropped: r.dropped, windowSec: WINDOW_MS / 1000 },
        }),
      );
    repeats.set(key, { windowStart: now, count: 1, dropped: 0 });
    return true;
  }
  if (r.count < repeatCap) {
    r.count++;
    return true;
  }
  r.dropped++;
  return false;
}

function write(level: Level, line: string): void {
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function emit(level: Level, component: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  if (!admit(level, component, msg, Date.now())) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...(data ? { data } : {}),
  });
  write(level, line);
}

export function logger(component: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => emit("debug", component, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => emit("info", component, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", component, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", component, msg, data),
  };
}

export function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
