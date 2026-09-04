/** JSON lines on stdout. No token address, wallet or signature in `msg`; put them in `data`. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

function emit(level: Level, component: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...(data ? { data } : {}),
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
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
