/**
 * Which mints get sampled, and how often (ADR-0007). Pure state machine:
 * active = seen in a poll within the active window (or pinned by an open
 * position or intent); cooling = seen within the cooling window; dropped
 * after that.
 */
export type SamplerConfig = {
  activeSampleMs: number;
  coolingSampleMs: number;
  activeWindowMs: number;
  coolingWindowMs: number;
};

export type MintState = { lastActiveAt: number; lastSampledAt: number; pinned: boolean };
export type Tier = "active" | "cooling" | "dropped";

export class Sampler {
  readonly mints = new Map<string, MintState>();
  readonly cfg: SamplerConfig;
  constructor(cfg: SamplerConfig) {
    this.cfg = cfg;
  }

  /** A poll saw this mint now. */
  seen(mint: string, now: number): void {
    const cur = this.mints.get(mint);
    if (cur) cur.lastActiveAt = now;
    else this.mints.set(mint, { lastActiveAt: now, lastSampledAt: 0, pinned: false });
  }

  pin(mint: string, pinned: boolean, now: number): void {
    const cur = this.mints.get(mint);
    if (cur) cur.pinned = pinned;
    else if (pinned) this.mints.set(mint, { lastActiveAt: now, lastSampledAt: 0, pinned: true });
  }

  tierOf(mint: string, now: number): Tier {
    const s = this.mints.get(mint);
    if (!s) return "dropped";
    if (s.pinned || now - s.lastActiveAt <= this.cfg.activeWindowMs) return "active";
    if (now - s.lastActiveAt <= this.cfg.coolingWindowMs) return "cooling";
    return "dropped";
  }

  /** Mints due for a sample at `now`, by tier. Drops expired ones as a side effect. */
  due(now: number): { active: string[]; cooling: string[] } {
    const active: string[] = [];
    const cooling: string[] = [];
    for (const [mint, s] of this.mints) {
      const tier = this.tierOf(mint, now);
      if (tier === "dropped") {
        this.mints.delete(mint);
        continue;
      }
      const every = tier === "active" ? this.cfg.activeSampleMs : this.cfg.coolingSampleMs;
      if (now - s.lastSampledAt >= every) (tier === "active" ? active : cooling).push(mint);
    }
    return { active, cooling };
  }

  sampled(mints: Iterable<string>, now: number): void {
    for (const m of mints) {
      const s = this.mints.get(m);
      if (s) s.lastSampledAt = now;
    }
  }

  counts(now: number): { active: number; cooling: number } {
    let active = 0;
    let cooling = 0;
    for (const mint of this.mints.keys()) {
      const t = this.tierOf(mint, now);
      if (t === "active") active++;
      else if (t === "cooling") cooling++;
    }
    return { active, cooling };
  }
}
