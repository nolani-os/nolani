/**
 * Version diff, the device-local twin of services/kb_diff.py.
 *
 * Word-wise diff of two Markdown revisions, computed on read. The matcher is a
 * faithful port of Python's `difflib.SequenceMatcher` with `autojunk=False`
 * (no junk heuristics), so the app shows exactly the same changes as the
 * server for the same two texts.
 */

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

// Words including trailing whitespace — joining them reproduces the text.
const TOKEN_RE = /\S+\s*|\s+/gu;
const MERGE_GAP = 3;

const tokens = (text: string): string[] => (text || "").match(TOKEN_RE) ?? [];

type Match = [number, number, number];
type Opcode = ["equal" | "delete" | "insert" | "replace", number, number, number, number];

/** difflib.SequenceMatcher(None, a, b, autojunk=False) — matching blocks and opcodes. */
class SequenceMatcher {
  private b2j = new Map<string, number[]>();

  constructor(private a: string[], private b: string[]) {
    b.forEach((elt, i) => {
      const list = this.b2j.get(elt);
      if (list) list.push(i);
      else this.b2j.set(elt, [i]);
    });
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // No junk (autojunk=False, isjunk=None): the extension loops for junk
    // elements never fire, exactly as in difflib.
    return [besti, bestj, bestsize];
  }

  matchingBlocks(): Match[] {
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Match[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    // Collapse adjacent equal blocks
    let i1 = 0, j1 = 0, k1 = 0;
    const out: Match[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) out.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return out;
  }

  opcodes(): Opcode[] {
    let i = 0, j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.matchingBlocks()) {
      let tag: Opcode[0] | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return answer;
  }
}

export function diffMarkdown(oldText: string, newText: string): DiffOp[] {
  const a = tokens(oldText), b = tokens(newText);
  const ops: (DiffOp & { n: number })[] = [];
  for (const [tag, i1, i2, j1, j2] of new SequenceMatcher(a, b).opcodes()) {
    if (tag === "equal") ops.push({ type: "equal", text: a.slice(i1, i2).join(""), n: i2 - i1 });
    else if (tag === "delete") ops.push({ type: "delete", text: a.slice(i1, i2).join(""), n: i2 - i1 });
    else if (tag === "insert") ops.push({ type: "insert", text: b.slice(j1, j2).join(""), n: j2 - j1 });
    else {
      ops.push({ type: "delete", text: a.slice(i1, i2).join(""), n: i2 - i1 });
      ops.push({ type: "insert", text: b.slice(j1, j2).join(""), n: j2 - j1 });
    }
  }
  // Absorb small "equal" islands between changes (readability)
  const merged: (DiffOp & { n: number })[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (op.type === "equal" && op.n <= MERGE_GAP && last && last.type !== "equal") {
      merged.push({ ...op, type: last.type });
    } else {
      merged.push(op);
    }
  }
  const out: DiffOp[] = [];
  for (const op of merged) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else out.push({ type: op.type, text: op.text });
  }
  return out;
}

/** Python `len(str)` counts code points, not UTF-16 units. */
const pyLen = (s: string) => [...s].length;

export function summarize(ops: DiffOp[]) {
  const added = ops.filter((o) => o.type === "insert").reduce((n, o) => n + pyLen(o.text), 0);
  const removed = ops.filter((o) => o.type === "delete").reduce((n, o) => n + pyLen(o.text), 0);
  return { added_chars: added, removed_chars: removed, changed: !!(added || removed) };
}
