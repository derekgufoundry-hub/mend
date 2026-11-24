// main.ts is mend, the CLI SPEC.md specifies. It started from the kit's starter (MIT), which did sections 1 to
// 4, 9 and 10 of SPEC.md; this version adds sections 5 to 8: matching lines at three tiers, unified diffs,
// SEARCH/REPLACE blocks and V4A patches, plus the `R old -> new` output line for moves (section 2).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Files and line matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** 0-based positions where O occurs in lines at the given tier; occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..2, or 0 only when strict) at which O occurs at least once, with its positions. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`. */
function findTierFrom(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, O, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NItem {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/**
 * The lines that replace the matched lines: context lines as the file's own matched lines, other lines
 * re-indented at tier 2 (section 5), as they are at tiers 0 and 1. `pos` is the occurrence's position.
 */
function buildNewLines(fileLines: string[], pos: number, O: string[], N: NItem[], tier: number): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(fileLines[pos]!)![0];
    P = /^[ \t]*/.exec(O[0]!)![0];
  }
  for (const item of N) {
    if (item.ctx) {
      out.push(fileLines[pos + item.oIndex]!);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
    else out.push(t);
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\' | '';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  sawHeader: boolean;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ stripped. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return { x, y };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** O and N of a hunk body, in body order; N marks its context lines with their O index. */
function hunkON(h: Hunk): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const b of h.body) {
    if (b.kind === ' ' || b.kind === '') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIndex: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    const k = h.body[i]!.kind;
    if (k === ' ' || k === '+' || k === '') last = i;
  }
  if (last < 0) return false;
  return h.body[last + 1] !== undefined && h.body[last + 1]!.kind === '\\';
}

/** Apply a section's hunks in order to the file's text; throws Fail('no-match', path). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h);
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const added = buildNewLines(f.lines, at, O, N, 0);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...added);
      if (atEnd) f.final = !hunkNoEol(h);
      d += N.length;
      continue;
    }
    const found = findTier(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const o of found.occ) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        best = dist;
        pos = o;
      }
    }
    const added = buildNewLines(f.lines, pos, O, N, found.tier);
    const runsToEnd = pos + O.length === f.lines.length;
    f.lines.splice(pos, O.length, ...added);
    if (runsToEnd) f.final = !hunkNoEol(h);
    d += N.length - O.length;
  }
  return renderFile(f);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const { x, y } = parseDiffGit(l, i + 1);
      cur = { oldPath: x, newPath: y, sawHeader: false, creation: false, deletion: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.sawHeader && cur.hunks.length === 0) {
        cur.oldPath = diffPath(l);
        cur.newPath = diffPath(lines[i + 1]!);
        cur.sawHeader = true;
      } else {
        cur = { oldPath: diffPath(l), newPath: diffPath(lines[i + 1]!), sawHeader: true, creation: false, deletion: false, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: '', text: '' });
          i++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          hunk.body.push({ kind: c as ' ' | '-' | '+' | '\\', text: bl.slice(1) });
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === '') hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ') && !cur.sawHeader) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !cur.sawHeader) cur.newPath = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.creation = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.deletion = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const isCreation = sec.creation || sec.oldPath === null;
    const isDeletion = !isCreation && (sec.deletion || sec.newPath === null);
    if (isCreation) {
      const p = sec.newPath;
      return (tree: Tree) => {
        if (p === null) return;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) {
          for (const b of h.body) if (b.kind === '+') plus.push(b.text);
        }
        let noEol = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const body = sec.hunks[hi]!.body;
          for (let bi = body.length - 1; bi >= 0; bi--) {
            if (body[bi]!.kind === '+') {
              noEol = body[bi + 1] !== undefined && body[bi + 1]!.kind === '\\';
              break outer;
            }
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (isDeletion) {
      const p = sec.oldPath;
      return (tree: Tree) => {
        if (p === null) return;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && newP !== null && oldP !== newP) {
      return (tree: Tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const cur = tree.get(oldP);
        if (cur === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(cur, sec.hunks, strict, oldP);
        tree.now.set(newP, out);
        tree.now.set(oldP, null);
        tree.moves.push({ old: oldP, nw: newP });
      };
    }
    const p = oldP ?? newP;
    return (tree: Tree) => {
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
      j++;
    }
    if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
    const sep = j;
    let k = sep + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
      k++;
    }
    if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, k);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = parseFile(cur);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const N: NItem[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
      const added = buildNewLines(f.lines, pos, oldLines, N, found.tier);
      f.lines.splice(pos, oldLines.length, ...added);
      tree.now.set(p, renderFile(f));
    });
    prevPath = p;
    prevEnd = k + 1;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aPath(line: string, marker: string): string {
  return line.slice(marker.length).trim();
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function chunkON(ch: V4aChunk): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const b of ch.body) {
    if (b.kind === ' ' || b.kind === '') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIndex: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { O, N };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const p = v4aPath(l, '*** Add File:');
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** ')) break;
        if (bl.startsWith('+')) {
          fileLines.push(bl.slice(1));
          i++;
          continue;
        }
        if (bl === '') {
          fileLines.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1]!.trim() === '') fileLines.pop();
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const p = v4aPath(l, '*** Delete File:');
      i++;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const p = v4aPath(l, '*** Update File:');
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = v4aPath(lines[i]!, '*** Move to:');
        i++;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** Add File:') || bl.startsWith('*** Delete File:') || bl.startsWith('*** Update File:')) break;
        if (bl.startsWith('*** Move to:')) throw new Exit2(`error: parse ${i + 1}`);
        if (bl === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          curChunk = null;
          firstChunk = false;
          i++;
          continue;
        }
        if (bl.startsWith('@@')) {
          const anchorText = bl.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          chunks.push(curChunk);
          firstChunk = false;
          i++;
          continue;
        }
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (curChunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: null, body: [], eof: false };
            chunks.push(curChunk);
            firstChunk = false;
          }
          curChunk.body.push({ kind: bl === '' ? '' : (bl[0] as ' ' | '-' | '+'), text: bl === '' ? '' : bl.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1]!;
        while (lastCh.body.length > 0) {
          const b = lastCh.body[lastCh.body.length - 1]!;
          if (b.kind === '' || (b.kind === ' ' && b.text.trim() === '')) lastCh.body.pop();
          else break;
        }
        if (lastCh.body.length === 0 && lastCh.anchor === null && !lastCh.eof) chunks.pop();
        else break;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const chs = chunks;
      const mv = moveTo;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        if (mv !== null) {
          if (!safe(mv)) throw new Fail('unsafe', mv);
          if (tree.get(mv) !== null) throw new Fail('exists', mv);
        }
        const f = parseFile(cur);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const at = findAnchor(f.lines, ch.anchor, cursor, strict);
            if (at < 0) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          const { O, N } = chunkON(ch);
          if (O.length === 0) {
            const at = ch.eof ? f.lines.length : cursor;
            const added = buildNewLines(f.lines, at, O, N, 0);
            f.lines.splice(at, 0, ...added);
            cursor = at + added.length;
            continue;
          }
          const found = findTierFrom(f.lines, O, cursor, strict);
          if (found === null) throw new Fail('no-match', p);
          let pos = found.occ[0]!;
          if (ch.eof) {
            const ok = found.occ.filter((o) => o + O.length === f.lines.length);
            if (ok.length === 0) throw new Fail('no-match', p);
            pos = ok[0]!;
          }
          const added = buildNewLines(f.lines, pos, O, N, found.tier);
          f.lines.splice(pos, O.length, ...added);
          cursor = pos + added.length;
        }
        const out = renderFile(f);
        if (mv !== null) {
          tree.now.set(mv, out);
          tree.now.set(p, null);
          tree.moves.push({ old: p, nw: mv });
        } else {
          tree.now.set(p, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Driver (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.nw) === null && tree.now.get(m.nw) !== null) {
      moved.set(m.old, m.nw);
    }
  }
  const movedNew = new Set(moved.values());
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moved.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [old, nw] of moved) rows.push({ key: nw, line: `R ${old} -> ${nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
