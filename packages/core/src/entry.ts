import type { FillSource } from "./market.ts";

export type LadderPhase = "confirm" | "dip" | "twap";

export interface Ladder {
  id: string;
  tokenId: string;
  phase: LadderPhase;
  status: "live" | "done" | "stopped";
  source: FillSource;
  budget: number;
  spent: number;
  markPx: number;
  lastFillPx: number;
  confirms: number;
  confirmNeed: number;
  confirmUntil: number;
  dipBps: number;
  dipNeed: number;
  dipDone: number;
  twapNeed: number;
  twapDone: number;
  intervalMs: number;
  nextAt: number;
  dipUntil: number;
  chain: boolean;
  pendingSol: number;
  pendingSrc: "dca" | "twap" | null;
  pendingSince: number;
}

export type LadderNote = { tokenId: string; en: string; kind: "flow" | "risk" };
export type LadderSlice = { tokenId: string; sol: number; source: "dca" | "twap" };

const CONFIRM_MS = 14_000;
const DIP_MS = 40_000;
const DIP_BPS = 130;
const DIP_NEED = 3;
const TWAP_NEED = 4;
const INTERVAL = 10_000;
const DUMP = 0.22;
const HOLD = 0.94;
const CHASE = 1.14;
const STALE_MS = 28_000;

function lid(): string {
  return `ld-${Math.random().toString(36).slice(2, 9)}`;
}

export function makeLadder(args: {
  tokenId: string;
  now: number;
  price: number;
  budget: number;
  source: FillSource;
  chain?: boolean;
}): Ladder {
  const budget = Math.max(0.15, args.budget);
  return {
    id: lid(),
    tokenId: args.tokenId,
    phase: "confirm",
    status: "live",
    source: args.source,
    budget,
    spent: 0,
    markPx: args.price,
    lastFillPx: args.price,
    confirms: 1,
    confirmNeed: 2,
    confirmUntil: args.now + CONFIRM_MS,
    dipBps: DIP_BPS,
    dipNeed: DIP_NEED,
    dipDone: 0,
    twapNeed: TWAP_NEED,
    twapDone: 0,
    intervalMs: INTERVAL,
    nextAt: args.now + 4_000,
    dipUntil: args.now + CONFIRM_MS + DIP_MS,
    chain: args.chain === true,
    pendingSol: 0,
    pendingSrc: null,
    pendingSince: 0,
  };
}

export function startLadder(
  ladders: Ladder[],
  args: Parameters<typeof makeLadder>[0],
): { ladders: Ladder[]; born: boolean } {
  const live = ladders.find((l) => l.tokenId === args.tokenId && l.status === "live");
  if (live) return { ladders: confirmLadder(ladders, args.tokenId, args.now), born: false };
  return {
    ladders: [makeLadder(args), ...ladders.filter((l) => l.status === "live")].slice(0, 12),
    born: true,
  };
}

export function confirmLadder(ladders: Ladder[], tokenId: string, now: number): Ladder[] {
  return ladders.map((l) => {
    if (l.tokenId !== tokenId || l.status !== "live" || l.phase !== "confirm") return l;
    const confirms = l.confirms + 1;
    if (confirms >= l.confirmNeed) return toDip(l, now, confirms);
    return { ...l, confirms };
  });
}

function toDip(l: Ladder, now: number, confirms = l.confirms): Ladder {
  return { ...l, confirms, phase: "dip", nextAt: now, dipUntil: now + DIP_MS };
}

function toTwap(l: Ladder, now: number): Ladder {
  const left = Math.max(0, l.dipNeed - l.dipDone);
  return {
    ...l,
    phase: "twap",
    twapNeed: l.twapNeed + left,
    dipDone: l.dipNeed,
    nextAt: now,
  };
}

function sliceSol(l: Ladder): number {
  const leftSlices =
    l.phase === "twap"
      ? Math.max(1, l.twapNeed - l.twapDone)
      : Math.max(1, l.dipNeed - l.dipDone + l.twapNeed - l.twapDone);
  const leftSol = Math.max(0, l.budget - l.spent);
  return Math.max(0.05, Math.min(leftSol, leftSol / leftSlices));
}

function dipTarget(l: Ladder): number {
  const step = (l.dipDone + 1) / Math.max(1, l.dipNeed);
  return l.markPx * (1 - (l.dipBps / 10_000) * step);
}

function waiting(l: Ladder, now: number): Ladder | null {
  if (!(l.chain && l.pendingSol >= 0.05)) return null;
  if (now - l.pendingSince > STALE_MS) {
    return { ...l, pendingSol: 0, pendingSrc: null, pendingSince: 0 };
  }
  return l;
}

function queueSlice(l: Ladder, now: number, sol: number, source: "dca" | "twap"): Ladder {
  return {
    ...l,
    pendingSol: sol,
    pendingSrc: source,
    pendingSince: now,
    nextAt: now + l.intervalMs,
  };
}

export function commitLadderSlice(
  ladders: Ladder[],
  tokenId: string,
  px: number,
  now: number,
): Ladder[] {
  return ladders.map((l) => {
    if (l.tokenId !== tokenId || l.pendingSol < 0.05) return l;
    const sol = l.pendingSol;
    const src = l.pendingSrc;
    const spent = l.spent + sol;
    let next: Ladder = {
      ...l,
      spent,
      lastFillPx: px > 0 ? px : l.lastFillPx,
      pendingSol: 0,
      pendingSrc: null,
      pendingSince: 0,
      nextAt: now + l.intervalMs,
    };
    if (src === "dca") {
      const dipDone = l.dipDone + 1;
      next = { ...next, dipDone };
      if (next.phase === "dip" && dipDone >= l.dipNeed) next = toTwap(next, now + l.intervalMs);
    } else if (src === "twap") {
      const twapDone = l.twapDone + 1;
      const done = twapDone >= l.twapNeed || spent + 0.049 >= l.budget;
      next = { ...next, twapDone, status: done ? "done" : "live" };
    }
    if (next.spent + 0.049 >= next.budget && next.phase !== "confirm") {
      next = { ...next, status: "done" };
    }
    return next;
  });
}

export function failLadderSlice(ladders: Ladder[], tokenId: string, now: number): Ladder[] {
  return ladders.map((l) => {
    if (l.tokenId !== tokenId || l.pendingSol < 0.05) return l;
    return {
      ...l,
      pendingSol: 0,
      pendingSrc: null,
      pendingSince: 0,
      nextAt: now + Math.max(l.intervalMs, 12_000),
    };
  });
}

export function tickLadders(
  ladders: Ladder[],
  ctx: {
    now: number;
    priceOf: (id: string) => number | null;
    edgeOk: (id: string) => boolean;
    alive: (id: string) => boolean;
  },
): { ladders: Ladder[]; slices: LadderSlice[]; notes: LadderNote[] } {
  const slices: LadderSlice[] = [];
  const notes: LadderNote[] = [];
  const next = ladders.map((raw) => {
    if (raw.status !== "live") return raw;
    let l = raw;
    const px = ctx.priceOf(l.tokenId);
    if (px == null || !ctx.alive(l.tokenId)) {
      notes.push({
        tokenId: l.tokenId,
        en: "Ladder stopped — name gone",
        kind: "risk",
      });
      return { ...l, status: "stopped" as const, pendingSol: 0, pendingSrc: null, pendingSince: 0 };
    }
    const hold = waiting(l, ctx.now);
    if (hold) {
      if (hold.pendingSol >= 0.05) return hold;
      l = hold;
    }

    if (l.phase === "confirm") {
      if (px < l.markPx * (1 - DUMP)) {
        notes.push({
          tokenId: l.tokenId,
          en: "Signal died — dump before confirm",
          kind: "risk",
        });
        return { ...l, status: "stopped" as const };
      }
      if (l.confirms >= l.confirmNeed) l = toDip(l, ctx.now);
      else if (ctx.now >= l.confirmUntil) {
        if (px >= l.markPx * HOLD && ctx.edgeOk(l.tokenId)) {
          notes.push({
            tokenId: l.tokenId,
            en: "Signal held — DCA down",
            kind: "flow",
          });
          l = toDip(l, ctx.now);
        } else {
          notes.push({
            tokenId: l.tokenId,
            en: "Signal faded — no entry",
            kind: "risk",
          });
          return { ...l, status: "stopped" as const };
        }
      } else return l;
    }
    if (l.phase === "dip") {
      if (ctx.now >= l.dipUntil) {
        notes.push({
          tokenId: l.tokenId,
          en: "Dip window done — TWAP in",
          kind: "flow",
        });
        l = toTwap(l, ctx.now);
      } else if (ctx.now >= l.nextAt && px <= dipTarget(l)) {
        const sol = sliceSol(l);
        if (sol >= 0.05 && l.spent + sol <= l.budget + 1e-9) {
          slices.push({ tokenId: l.tokenId, sol, source: "dca" });
          if (l.chain) return queueSlice(l, ctx.now, sol, "dca");
          const dipDone = l.dipDone + 1;
          l = {
            ...l,
            spent: l.spent + sol,
            lastFillPx: px,
            dipDone,
            nextAt: ctx.now + l.intervalMs,
          };
          if (dipDone >= l.dipNeed) l = toTwap(l, ctx.now + l.intervalMs);
        } else l = { ...l, nextAt: ctx.now + l.intervalMs };
      }
    }
    if (l.phase === "twap") {
      if (l.spent + 0.049 >= l.budget || l.twapDone >= l.twapNeed) {
        return { ...l, status: "done" as const };
      }
      if (ctx.now < l.nextAt) return l;
      if (px > l.markPx * CHASE) {
        return { ...l, nextAt: ctx.now + l.intervalMs };
      }
      const sol = sliceSol(l);
      if (sol < 0.05) return { ...l, status: "done" as const };
      slices.push({ tokenId: l.tokenId, sol, source: "twap" });
      if (l.chain) return queueSlice(l, ctx.now, sol, "twap");
      const twapDone = l.twapDone + 1;
      const spent = l.spent + sol;
      const done = twapDone >= l.twapNeed || spent + 0.049 >= l.budget;
      return {
        ...l,
        spent,
        lastFillPx: px,
        twapDone,
        nextAt: ctx.now + l.intervalMs,
        status: done ? ("done" as const) : ("live" as const),
      };
    }
    return l;
  });
  return { ladders: next, slices, notes };
}

export function phaseMsg(phase: LadderPhase): { en: string } {
  if (phase === "confirm") return { en: "Confirm" };
  if (phase === "dip") return { en: "DCA down" };
  return { en: "TWAP" };
}
