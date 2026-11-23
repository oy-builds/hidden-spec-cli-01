// mend — one patch tool for every AI edit format.
//
// mend applies an edit that an AI model wrote to a tree of text files. The
// patch may be a unified diff (often with wrong line numbers), SEARCH/REPLACE
// blocks, a V4A patch, or text-editor tool calls as JSON. SPEC.md is the whole
// contract; this file implements it end to end: the command line, the output
// and exit codes, safe paths, format detection, the three matching tiers, the
// four readers, and the all-or-nothing write.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`
// with the working directory as the root of the tree.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set;
// the hand-over at the bottom of this file then passes control to runner.ts,
// which the kit ships and which stays as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ */
/* Failures                                                            */
/* ------------------------------------------------------------------ */

/** An exit-2 outcome: the single line to print, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: a code and the path the failure concerns. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/* ------------------------------------------------------------------ */
/* Text, lines and paths (SPEC.md section 3)                           */
/* ------------------------------------------------------------------ */

/** The patch's lines: split at \n, one trailing \r removed from each, and
 *  no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A path is safe when it is not empty, does not start with /, holds no
 *  backslash, and no /-separated segment of it is empty, . or .. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file as lines: its own line break, the lines split at it, and whether
 *  the text ends with that break. An empty file has no lines and no final
 *  break. */
interface FileLines {
  lines: string[];
  brk: '\n' | '\r\n';
  final: boolean;
}

function toLines(text: string): FileLines {
  if (text === '') return { lines: [], brk: '\n', final: false };
  const nl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let final = false;
  if (text.endsWith(brk)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, brk, final };
}

function fromLines(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.brk) + (fl.final ? fl.brk : '');
}

/* ------------------------------------------------------------------ */
/* The tree: every edit works on this in-memory view, so a patch       */
/* writes everything or nothing.                                       */
/* ------------------------------------------------------------------ */

class Tree {
  private readonly before = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  /** The path's text before the patch (null: it does not exist). */
  original(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  /** The path's text as the edits so far have left it. */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

/** One edit of a patch: apply it to the tree, or throw EditFail. A move
 *  that succeeds is recorded in `moves` for the R lines of section 2. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

function needSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFail('unsafe', p);
}

function needPresent(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new EditFail('missing', p);
  return t;
}

function needAbsent(tree: Tree, p: string): void {
  if (tree.get(p) !== null) throw new EditFail('exists', p);
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at which O occurs in lines at the tier;
 *  occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier at which O occurs at least once (tier 0 only when
 *  strict), or null when it occurs nowhere. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier).filter((i) => i >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of a hunk or chunk body: context, deletion, addition, or a
 *  backslash ("no newline") marker naming the body line before it. */
interface Item {
  t: 'c' | 'd' | 'a' | 'b';
  s: string;
}

function oldLines(items: Item[]): string[] {
  const out: string[] = [];
  for (const it of items) if (it.t === 'c' || it.t === 'd') out.push(it.s);
  return out;
}

/** The lines a matched hunk or chunk writes: context lines are the file's
 *  own matched lines; at tier 2 every other new line is re-indented from
 *  O's first line's indentation to the file's first matched line's. */
function buildNew(lines: string[], pos: number, items: Item[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  let p = '';
  let f = '';
  if (tier === 2) {
    const first = items.find((it) => it.t === 'c' || it.t === 'd');
    p = first === undefined ? '' : leadWs(first.s);
    f = leadWs(lines[pos] ?? '');
  }
  for (const it of items) {
    if (it.t === 'c') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (it.t === 'd') {
      oi += 1;
    } else if (it.t === 'a') {
      let s = it.s;
      if (tier === 2 && s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(p)) {
        s = f + s.slice(p.length);
      }
      out.push(s);
    }
  }
  return out;
}

/** Whether a backslash line follows the body's last context or + line. */
function backslashAfterLast(items: Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const t = items[i]!.t;
    if (t === 'c' || t === 'a') return items[i + 1]?.t === 'b';
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null | undefined;
  plus: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    gitOld: null,
    gitNew: null,
    minus: undefined,
    plus: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

/** The path a --- or +++ line names: the text after the four characters,
 *  up to the first tab, surrounding spaces removed, a leading a/ or b/
 *  removed; /dev/null means no file (null). */
function headerPath(line: string): string | null {
  const raw = line
    .slice(4)
    .split('\t')[0]!
    .replace(/^ +| +$/g, '');
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line. */
function gitPaths(line: string, num: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${num}`);
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) throw new Exit2(`error: parse ${num}`);
  return [rest.slice(2, idx), rest.slice(idx + 3)];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const num = i + 1;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, num);
      cur = newSection();
      cur.gitOld = x;
      cur.gitNew = y;
      sections.push(cur);
      i += 1;
      continue;
    }
    const isMinus = line.startsWith('--- ');
    const nextPlus = (lines[i + 1] ?? '').startsWith('+++ ');
    if (isMinus && nextPlus && cur !== null && cur.hunks.length === 0 && cur.minus === undefined) {
      cur.minus = headerPath(line);
      cur.plus = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (isMinus && nextPlus) {
      cur = newSection();
      cur.minus = headerPath(line);
      cur.plus = headerPath(lines[i + 1]!);
      sections.push(cur);
      i += 2;
      continue;
    }
    if (isMinus && cur !== null && cur.hunks.length === 0) {
      // A --- line inside a section's header, not followed by a +++ line.
      throw new Exit2(`error: parse ${num + 1}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${num}`);
      const items: Item[] = [];
      const raws: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '') items.push({ t: 'c', s: '' });
        else if (c === ' ') items.push({ t: 'c', s: bl.slice(1) });
        else if (c === '-') items.push({ t: 'd', s: bl.slice(1) });
        else if (c === '+') items.push({ t: 'a', s: bl.slice(1) });
        else if (c === '\\') items.push({ t: 'b', s: bl.slice(1) });
        else break;
        raws.push(bl);
        j += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (items.length > 0 && raws[raws.length - 1] === '') {
        items.pop();
        raws.pop();
      }
      cur.hunks.push({ a: Number(m[1]), items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    // Anything else, outside a body, is prose and ignored.
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's lines. `d` is the running
 *  sum of (new length - old length) over the section's hunks so far. */
function applyHunks(fl: FileLines, hunks: Hunk[], strict: boolean, errPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = oldLines(h.items);
    if (o.length === 0) {
      const adds: string[] = [];
      for (const it of h.items) if (it.t === 'a') adds.push(it.s);
      const pos = Math.max(0, Math.min(h.a + d, fl.lines.length));
      const atEnd = pos === fl.lines.length;
      fl.lines.splice(pos, 0, ...adds);
      if (atEnd && adds.length > 0) fl.final = !backslashAfterLast(h.items);
      d += adds.length;
      continue;
    }
    const found = findTier(fl.lines, o, strict);
    if (found === null) throw new EditFail('no-match', errPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const at of found.occ) {
      const dist = Math.abs(at - target);
      if (dist < bestDist) {
        best = at;
        bestDist = dist;
      }
    }
    const touchesEnd = best + o.length === fl.lines.length;
    const repl = buildNew(fl.lines, best, h.items, found.tier);
    fl.lines.splice(best, o.length, ...repl);
    if (touchesEnd) fl.final = !backslashAfterLast(h.items);
    d += repl.length - o.length;
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.minus !== undefined ? s.minus : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newP = s.plus !== undefined ? s.plus : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  const isCreate = oldP === null || s.newFile;
  const isDelete = !isCreate && (newP === null || s.delFile);
  return (tree, moves) => {
    if (isCreate) {
      const p = newP ?? oldP ?? '';
      needSafe(p);
      needAbsent(tree, p);
      const out: string[] = [];
      for (const h of s.hunks) {
        for (const it of h.items) if (it.t === 'a') out.push(it.s);
      }
      // A created file ends with a line break unless a \ line follows its
      // last + line.
      let fin = true;
      let seen = false;
      for (let hi = s.hunks.length - 1; hi >= 0 && !seen; hi -= 1) {
        const items = s.hunks[hi]!.items;
        for (let ii = items.length - 1; ii >= 0; ii -= 1) {
          if (items[ii]!.t === 'a') {
            fin = items[ii + 1]?.t !== 'b';
            seen = true;
            break;
          }
        }
      }
      tree.set(p, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      needSafe(p);
      needPresent(tree, p);
      tree.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const o = oldP ?? '';
      const n = newP ?? '';
      needSafe(o);
      needSafe(n);
      const before = needPresent(tree, o);
      needAbsent(tree, n);
      const fl = toLines(before);
      applyHunks(fl, s.hunks, strict, o);
      tree.set(n, fromLines(fl));
      tree.set(o, null);
      moves.push([o, n]);
      return;
    }
    const p = oldP ?? '';
    needSafe(p);
    const before = needPresent(tree, p);
    const fl = toLines(before);
    applyHunks(fl, s.hunks, strict, p);
    tree.set(p, fromLines(fl));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldL: string[];
  newL: string[];
}

const rtrimEq = (l: string, marker: string): boolean => l.trimEnd() === marker;

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (!rtrimEq(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const searchNum = i + 1;
    // The path: the nearest line before the SEARCH line, after the
    // previous block, that is not blank and does not open a code fence.
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchNum}`);
    }
    let k = i + 1;
    while (k < lines.length && !rtrimEq(lines[k]!, '=======')) k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchNum}`);
    let m = k + 1;
    while (m < lines.length && !rtrimEq(lines[m]!, '>>>>>>> REPLACE')) m += 1;
    if (m >= lines.length) throw new Exit2(`error: parse ${searchNum}`);
    blocks.push({ path, oldL: lines.slice(i + 1, k), newL: lines.slice(k + 1, m) });
    i = m + 1;
    searchFrom = i;
  }
  return blocks;
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    needSafe(b.path);
    if (b.oldL.length === 0) {
      needAbsent(tree, b.path);
      tree.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
      return;
    }
    const before = needPresent(tree, b.path);
    const fl = toLines(before);
    const found = findTier(fl.lines, b.oldL, strict);
    if (found === null) throw new EditFail('no-match', b.path);
    if (found.occ.length > 1) throw new EditFail('ambiguous', b.path);
    const items: Item[] = [
      ...b.oldL.map((s): Item => ({ t: 'd', s })),
      ...b.newL.map((s): Item => ({ t: 'a', s })),
    ];
    const repl = buildNew(fl.lines, found.occ[0]!, items, found.tier);
    fl.lines.splice(found.occ[0]!, b.oldL.length, ...repl);
    tree.set(b.path, fromLines(fl));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  num: number;
  addLines: string[];
  moveTo: string | undefined;
  chunks: Chunk[];
}

const V_HEADS: Array<[string, VSection['kind']]> = [
  ['*** Add File:', 'add'],
  ['*** Delete File:', 'del'],
  ['*** Update File:', 'upd'],
];

function vHead(line: string): { kind: VSection['kind']; path: string } | null {
  for (const [prefix, kind] of V_HEADS) {
    if (line.startsWith(prefix)) {
      return { kind, path: line.slice(prefix.length).replace(/^ +| +$/g, '') };
    }
  }
  return null;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const head = vHead(lines[i]!);
    if (head === null) {
      if (isBlank(lines[i]!)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const body: Array<{ text: string; num: number }> = [];
    let j = i + 1;
    while (j < last && vHead(lines[j]!) === null) {
      body.push({ text: lines[j]!, num: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
    sections.push(buildVSection(head.kind, head.path, i + 1, body));
    i = j;
  }
  return sections;
}

function buildVSection(
  kind: VSection['kind'],
  path: string,
  num: number,
  body: Array<{ text: string; num: number }>,
): VSection {
  const sec: VSection = { kind, path, num, addLines: [], moveTo: undefined, chunks: [] };
  if (kind === 'add') {
    for (const { text, num: n } of body) {
      if (text.startsWith('+')) sec.addLines.push(text.slice(1));
      else if (text === '') sec.addLines.push('');
      else throw new Exit2(`error: parse ${n}`);
    }
    return sec;
  }
  if (kind === 'del') {
    if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.num}`);
    return sec;
  }
  let cur: Chunk | null = null;
  body.forEach(({ text, num: n }, idx) => {
    if (idx === 0 && text.startsWith('*** Move to:')) {
      sec.moveTo = text.slice('*** Move to:'.length).replace(/^ +| +$/g, '');
      return;
    }
    if (text.startsWith('@@')) {
      cur = { anchor: text.slice(2).trim() || null, eof: false, items: [] };
      sec.chunks.push(cur);
      return;
    }
    if (text.startsWith('*** End of File') && text.trimEnd() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, eof: true, items: [] };
        sec.chunks.push(cur);
      } else {
        cur.eof = true;
      }
      cur = null;
      return;
    }
    const c = text[0];
    if (text === '' || c === ' ' || c === '-' || c === '+') {
      if (cur === null) {
        cur = { anchor: null, eof: false, items: [] };
        sec.chunks.push(cur);
      }
      cur.items.push({
        t: text === '' || c === ' ' ? 'c' : c === '-' ? 'd' : 'a',
        s: text === '' ? '' : text.slice(1),
      });
      return;
    }
    throw new Exit2(`error: parse ${n}`);
  });
  if (sec.chunks.length === 0 && sec.moveTo === undefined) {
    throw new Exit2(`error: parse ${num}`);
  }
  return sec;
}

/** The first line at or after the cursor equal to the anchor, at the
 *  first tier where one is; -1 when there is none. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = cursor; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree, moves) => {
    needSafe(sec.path);
    if (sec.kind === 'add') {
      needAbsent(tree, sec.path);
      tree.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      needPresent(tree, sec.path);
      tree.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined) needSafe(sec.moveTo);
    const before = needPresent(tree, sec.path);
    if (sec.moveTo !== undefined) needAbsent(tree, sec.moveTo);
    const fl = toLines(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(fl.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new EditFail('no-match', sec.path);
        cursor = at + 1;
      }
      const o = oldLines(ch.items);
      if (o.length === 0) {
        const adds: string[] = [];
        for (const it of ch.items) if (it.t === 'a') adds.push(it.s);
        const pos = ch.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let placed: { tier: number; at: number } | null = null;
      for (const tier of tiers) {
        const occ = occurrences(fl.lines, o, tier).filter(
          (at) => at >= cursor && (!ch.eof || at + o.length === fl.lines.length),
        );
        if (occ.length > 0) {
          placed = { tier, at: occ[0]! };
          break;
        }
      }
      if (placed === null) throw new EditFail('no-match', sec.path);
      const repl = buildNew(fl.lines, placed.at, ch.items, placed.tier);
      fl.lines.splice(placed.at, o.length, ...repl);
      cursor = placed.at + repl.length;
    }
    const text = fromLines(fl);
    if (sec.moveTo !== undefined) {
      tree.set(sec.moveTo, text);
      tree.set(sec.path, null);
      moves.push([sec.path, sec.moveTo]);
    } else {
      tree.set(sec.path, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

type JsonEdit =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'str'; path: string; oldS: string; newS: string }
  | { kind: 'insert'; path: string; at: number; text: string };

/** One JSON edit object, or null when it is not one: a wrong command or a
 *  missing or mistyped key is a parse fault. */
function jsonEditOf(v: unknown): JsonEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'create', path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { kind: 'str', path, oldS: o.old_str, newS: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'insert', path, at: o.insert_line, text: o.new_str };
  }
  return null;
}

function parseJson(text: string, lines: string[]): JsonEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: JsonEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditOf(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: JsonEdit | null = null;
    try {
      e = jsonEditOf(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

function jsonApply(e: JsonEdit): Edit {
  return (tree) => {
    needSafe(e.path);
    if (e.kind === 'create') {
      needAbsent(tree, e.path);
      tree.set(e.path, e.text);
      return;
    }
    const before = needPresent(tree, e.path);
    if (e.kind === 'str') {
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(e.oldS);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', e.path);
      if (count > 1) throw new EditFail('ambiguous', e.path);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(e.newS) + t.slice(at + old.length);
      tree.set(e.path, crlf ? out.replaceAll('\n', '\r\n') : out);
      return;
    }
    const fl = toLines(before);
    if (e.at < 0 || e.at > fl.lines.length) throw new EditFail('no-match', e.path);
    fl.lines.splice(e.at, 0, ...patchLines(e.text));
    tree.set(e.path, fromLines(fl));
  };
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC.md section 4)                            */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => rtrimEq(l, '<<<<<<< SEARCH'))) return 'search-replace';
  if (
    lines.some(
      (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** Read the whole patch in its format: the edits, in the patch's order.
 *  Any structural fault is an Exit2, reported before any file is read. */
function readEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  let edits: Edit[];
  if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
  else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
  else if (kind === 'v4a') edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
  else edits = parseJson(text, lines).map((e) => jsonApply(e));
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* The command line (SPEC.md sections 1, 2 and 10)                     */
/* ------------------------------------------------------------------ */

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function runCli(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positional.length === 0 ? null : positional[0]!;
  let text = '';
  if (patchArg === null || patchArg === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits = readEdits(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // The paths whose state changed, in byte order of the paths (UTF-8);
  // a successful move replaces its pair's D and A lines with one R line
  // that sorts by the new path.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const is = tree.now.get(p)!;
    if (was === is || covered.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : is === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  if (!checkOnly) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const is = tree.now.get(p)!;
      if (was === is) continue;
      if (is === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, is, 'utf8');
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

/* ------------------------------------------------------------------ */
/* Entry: a trial hands over to the kit's runner; anything else is     */
/* the CLI.                                                            */
/* ------------------------------------------------------------------ */

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
