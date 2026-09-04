/**
 * Split a migration file into statements. TimescaleDB refuses continuous
 * aggregates inside a transaction block, and node-postgres runs a
 * multi-statement string as one implicit block, so each statement is sent
 * on its own. Handles `$$` bodies and `--` comments; no other dialect tricks.
 */
export function splitSql(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  let inLine = false;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") inLine = false;
      continue;
    }
    if (!inDollar && !inStr && ch === "-" && next === "-") {
      inLine = true;
      i++;
      continue;
    }
    if (!inDollar && ch === "'") inStr = !inStr;
    if (!inStr && ch === "$" && next === "$") {
      inDollar = !inDollar;
      cur += "$$";
      i++;
      continue;
    }
    if (!inDollar && !inStr && ch === ";") {
      const s = cur.trim();
      if (s) out.push(s);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}
