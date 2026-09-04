/**
 * Prometheus metrics, prefix `wick_` (ENGINE §15). Never a label with a
 * token address, wallet or signature; those go to `events`.
 */
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "wick_process_" });

export const up = new client.Gauge({
  name: "wick_up",
  help: "1 while the engine runs",
  registers: [registry],
});

export const sourceHeartbeatAge = new client.Gauge({
  name: "wick_source_heartbeat_age_seconds",
  help: "Seconds since a source last answered with usable data",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const sourceCallDuration = new client.Histogram({
  name: "wick_source_call_duration_seconds",
  help: "Duration of one call to a source",
  labelNames: ["source"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
  registers: [registry],
});

export const slotLag = new client.Gauge({
  name: "wick_slot_lag",
  help: "Highest slot seen across endpoints minus the primary endpoint's slot",
  registers: [registry],
});

export const eventLoopLag = new client.Gauge({
  name: "wick_event_loop_lag_seconds",
  help: "Event loop lag measured every second",
  registers: [registry],
});

export const activeTokens = new client.Gauge({
  name: "wick_active_tokens",
  help: "Tokens sampled at the active cadence",
  labelNames: ["state"] as const,
  registers: [registry],
});

export const snapshotsWritten = new client.Counter({
  name: "wick_snapshots_written_total",
  help: "token_snapshots rows written",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const auditsWritten = new client.Counter({
  name: "wick_audits_written_total",
  help: "audits rows written (only on change)",
  registers: [registry],
});

export const launchTxsParsed = new client.Counter({
  name: "wick_launch_txs_parsed_total",
  help: "launch_txs rows written",
  registers: [registry],
});

export const chainEvents = new client.Counter({
  name: "wick_chain_events_total",
  help: "chain_events rows written, by kind",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const streamConnected = new client.Gauge({
  name: "wick_stream_connected",
  help: "1 when the RPC WebSocket log stream is connected",
  registers: [registry],
});

export const streamSubscriptions = new client.Gauge({
  name: "wick_stream_subscriptions",
  help: "Live logsSubscribe subscriptions",
  registers: [registry],
});

export const streamEvents = new client.Counter({
  name: "wick_stream_events_total",
  help: "Log notifications handled, by what they became",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const walletPrints = new client.Counter({
  name: "wick_wallet_prints_total",
  help: "wallet_prints rows written",
  registers: [registry],
});

export const microRows = new client.Counter({
  name: "wick_microstructure_rows_total",
  help: "microstructure rows written",
  registers: [registry],
});

export const ingestCycle = new client.Histogram({
  name: "wick_ingest_cycle_duration_seconds",
  help: "One ingest tick, poll to commit",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const funnel = new client.Counter({
  name: "wick_funnel_total",
  help: "Candidates entering and leaving each decision layer",
  labelNames: ["layer", "outcome"] as const,
  registers: [registry],
});

export const decisionDuration = new client.Histogram({
  name: "wick_decision_duration_seconds",
  help: "Feature row read to intent written",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

export const rejections = new client.Counter({
  name: "wick_rejections_total",
  help: "Gate rejections by reason code",
  labelNames: ["gate", "reason"] as const,
  registers: [registry],
});

export const halted = new client.Gauge({
  name: "wick_halted",
  help: "1 while a halt of this kind is active",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const dbErrors = new client.Counter({
  name: "wick_db_errors_total",
  help: "Failed database statements",
  labelNames: ["op"] as const,
  registers: [registry],
});

/** Measures the event loop every second; call once at start. */
export function watchEventLoop(): () => void {
  let last = process.hrtime.bigint();
  const t = setInterval(() => {
    const now = process.hrtime.bigint();
    const lagMs = Number(now - last) / 1e6 - 1000;
    eventLoopLag.set(Math.max(0, lagMs) / 1000);
    last = now;
  }, 1000);
  t.unref();
  return () => clearInterval(t);
}
