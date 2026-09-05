/**
 * The kill switch (ADR-0003): a file on disk the engine checks every second,
 * by a path independent of its own health. Set over SSH (`touch`), with an
 * optional reason as its content; removed by hand to clear. Money stops in
 * the engine, not in a notification.
 */
import { existsSync, readFileSync } from "node:fs";

export type KillState = { active: boolean; reason: string | null; since: number | null };

export class KillSwitch {
  readonly state: KillState = { active: false, reason: null, since: null };
  private readonly file: string;
  private readonly onChange: (state: KillState) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(file: string, onChange: (state: KillState) => void = () => {}) {
    this.file = file;
    this.onChange = onChange;
  }

  /** Read the file once; returns true when the state flipped. Public for tests. */
  check(now = Date.now()): boolean {
    let active: boolean;
    let reason: string | null = null;
    try {
      active = existsSync(this.file);
      if (active)
        reason = readFileSync(this.file, "utf8").trim().slice(0, 200) || "kill file present";
    } catch {
      // A file we cannot read is still a file: stay on the safe side.
      active = true;
      reason = "kill file unreadable";
    }
    const flipped = active !== this.state.active;
    this.state.active = active;
    this.state.reason = active ? reason : null;
    if (flipped) {
      this.state.since = active ? now : null;
      this.onChange({ ...this.state });
    }
    return flipped;
  }

  start(everyMs = 1000): void {
    this.check();
    this.timer = setInterval(() => this.check(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
