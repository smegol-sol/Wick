import type { Msg } from "./i18n";

export type Cluster = "dog" | "cat" | "frog" | "ai" | "tick" | "politic" | "cult" | "other";

export const CLUSTER_MSG: Record<Cluster, Msg> = {
  dog: "clusterDog",
  cat: "clusterCat",
  frog: "clusterFrog",
  ai: "clusterAi",
  tick: "clusterTick",
  politic: "clusterPolitic",
  cult: "clusterCult",
  other: "clusterOther",
};

const RULES: Array<[Cluster, RegExp]> = [
  ["dog", /\b(dog|doge|bonk|wif|shib|inu|woof|puppy|floki)\b/],
  ["cat", /\b(cat|kitten|mew|popcat|neko|purr)\b/],
  ["frog", /\b(pepe|frog|apu|kek)\b/],
  ["ai", /\b(ai|gpt|grok|agent|llm|neural|bot|eliza)\b/],
  ["politic", /\b(trump|biden|maga|vote|elon|president)\b/],
  ["tick", /\b(sol|pump|moon|rocket|100x|gem)\b/],
  ["cult", /\b(chad|coin|based|cult|meme)\b/],
];

const FALLBACK: Cluster[] = ["dog", "ai", "tick", "cult", "frog", "other"];

function hay(symbol: string, name?: string): string {
  return `${symbol} ${name ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function clusterOf(symbol: string, name?: string): Cluster {
  const text = hay(symbol, name);
  if (text) {
    for (const [id, re] of RULES) {
      if (re.test(text)) return id;
    }
  }
  return FALLBACK[hash(symbol.toUpperCase()) % FALLBACK.length];
}

export function clusterNames(
  positions: Array<{ tokenId: string }>,
  tokens: Array<{ id: string; symbol: string; name?: string }>,
  cluster: Cluster,
): number {
  const ids = new Set<string>();
  for (const p of positions) {
    const tk = tokens.find((t) => t.id === p.tokenId);
    if (!tk) continue;
    if (clusterOf(tk.symbol, tk.name) === cluster) ids.add(p.tokenId);
  }
  return ids.size;
}

export function hottestCluster(
  positions: Array<{ tokenId: string; costSol: number }>,
  tokens: Array<{ id: string; symbol: string; name?: string }>,
): { cluster: Cluster; names: number; cost: number } | null {
  if (!positions.length) return null;
  const map = new Map<Cluster, { names: Set<string>; cost: number }>();
  for (const p of positions) {
    const tk = tokens.find((t) => t.id === p.tokenId);
    if (!tk) continue;
    const c = clusterOf(tk.symbol, tk.name);
    const cur = map.get(c) ?? { names: new Set<string>(), cost: 0 };
    cur.names.add(p.tokenId);
    cur.cost += p.costSol;
    map.set(c, cur);
  }
  let best: { cluster: Cluster; names: number; cost: number } | null = null;
  for (const [cluster, v] of map) {
    const row = { cluster, names: v.names.size, cost: v.cost };
    if (!best || row.names > best.names || (row.names === best.names && row.cost > best.cost))
      best = row;
  }
  return best;
}
