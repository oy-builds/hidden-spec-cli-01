// tests/run.mjs — an independent battery for mend, beyond the kit's practice
// set: `node tests/run.mjs`. Each case runs main.ts in a fresh directory and
// compares the exit code, stdout and every file afterwards, exactly as a
// check does. Expectations here are worked out from SPEC.md by hand.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

let passed = 0;
let failed = 0;

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  try {
    for (const d of c.dirs ?? []) mkdirSync(join(dir, ...d.split('/')), { recursive: true });
    for (const [p, t] of Object.entries(c.files ?? {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, t);
    }
    const r = spawnSync(process.execPath, [MAIN, ...(c.argv ?? [])], {
      cwd: dir,
      input: c.stdin ?? '',
      encoding: 'utf8',
    });
    const problems = [];
    if (r.status !== c.exit) problems.push(`exit ${r.status}, want ${c.exit}`);
    if ((r.stdout ?? '') !== (c.stdout ?? '')) {
      problems.push(`stdout ${JSON.stringify(r.stdout)}, want ${JSON.stringify(c.stdout ?? '')}`);
    }
    const got = readTree(dir);
    const want = c.after ?? c.files ?? {};
    for (const p of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (want[p] === undefined) problems.push(`${p} should not exist`);
      else if (got[p] === undefined) problems.push(`${p} is missing`);
      else if (got[p] !== want[p]) problems.push(`${p} is ${JSON.stringify(got[p])}, want ${JSON.stringify(want[p])}`);
    }
    if (problems.length > 0) {
      failed += 1;
      const err = (r.stderr ?? '').split('\n').slice(0, 2).join(' | ');
      process.stdout.write(`FAIL ${c.name}: ${problems.join('; ')}${err ? ` (stderr: ${err})` : ''}\n`);
    } else {
      passed += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [];
const T = (name, c) => cases.push({ name, ...c });

/* ---------------- unified diffs ---------------- */

T('u-nearest-occurrence', {
  files: { 'f.txt': 'x\na\nb\nx\na\nb\n', 'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n a\n-b\n+B\n' },
  argv: ['p.diff'],
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'x\na\nB\nx\na\nb\n', 'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n a\n-b\n+B\n' },
});

T('u-nearest-tie-takes-earlier', {
  files: { 'f.txt': 'z\na\nb\na\nb\n' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -3,2 +3,2 @@\n a\n-b\n+B\n',
  argv: ['-'],
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'z\na\nB\na\nb\n' },
});

T('u-drift-from-earlier-hunk', {
  files: { 'f.txt': 'a\n5\nb\n5\nc\n' },
  stdin:
    '--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n@@ -4,1 +4,1 @@\n-5\n+FIVE\n',
  argv: [],
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'x\ny\na\n5\nb\nFIVE\nc\n' },
});

T('u-insert-middle', {
  files: { 'f.txt': 'a\nb\nc\n' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +2,1 @@\n+ins\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\nins\nb\nc\n' },
});

T('u-insert-at-end-backslash', {
  files: { 'f.txt': 'a\nb' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,1 @@\n+c\n\\ No newline at end of file\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\nb\nc' },
});

T('u-insert-at-end-plain', {
  files: { 'f.txt': 'a\nb' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,1 @@\n+c\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\nb\nc\n' },
});

T('u-create-backslash', {
  files: { 'p.diff': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n' },
  argv: ['p.diff'],
  exit: 0,
  stdout: 'A new.txt\nok: 1 file\n',
  after: {
    'p.diff': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n',
    'new.txt': 'one\ntwo',
  },
});

T('u-delete-hunks-not-read', {
  files: { 'del.txt': 'keep?\n', 'p.diff': '--- a/del.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-nonexistent\n' },
  argv: ['p.diff'],
  exit: 0,
  stdout: 'D del.txt\nok: 1 file\n',
  after: { 'p.diff': '--- a/del.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-nonexistent\n' },
});

T('u-rename-from-to', {
  files: { 'old.txt': 'data\n', 'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n' },
  argv: ['p.diff'],
  exit: 0,
  stdout: 'R old.txt -> new.txt\nok: 1 file\n',
  after: { 'new.txt': 'data\n', 'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n' },
});

T('u-move-with-hunks', {
  files: { 'a.txt': 'one\ntwo\n' },
  stdin: 'diff --git a/a.txt b/b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -2,1 +2,1 @@\n-two\n+TWO\n',
  exit: 0,
  stdout: 'R a.txt -> b.txt\nok: 1 file\n',
  after: { 'b.txt': 'one\nTWO\n' },
});

T('u-parse-minus-without-plus', {
  files: { 'p.diff': 'diff --git a/x b/x\n--- a/x\nzzz\n' },
  argv: ['p.diff'],
  exit: 2,
  stdout: 'error: parse 3\n',
});

T('u-parse-bad-git-line', {
  files: {},
  stdin: 'diff --git nonsense\n',
  exit: 2,
  stdout: 'error: parse 1\n',
});

T('u-parse-hunk-before-section', {
  files: {},
  stdin: '@@ -1 +1 @@\n x\n',
  argv: ['--format=unified'],
  exit: 2,
  stdout: 'error: parse 1\n',
});

T('u-parse-bad-hunk-head', {
  files: { 'p.diff': 'diff --git a/x b/x\n@@ nope @@\n' },
  argv: ['p.diff'],
  exit: 2,
  stdout: 'error: parse 2\n',
});

T('u-crlf-preserved', {
  files: { 'f.txt': 'a\r\nb\r\nc\r\n' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\r\nB\r\nc\r\n' },
});

T('u-tier2-reindent', {
  files: { 'f.py': 'def f():\n    if x:\n        return 1\n' },
  stdin: '--- a/f.py\n+++ b/f.py\n@@ -2,2 +2,2 @@\n   if x:\n-     return 1\n+     return 2\n',
  exit: 0,
  stdout: 'M f.py\nok: 1 file\n',
  after: { 'f.py': 'def f():\n    if x:\n       return 2\n' },
});

T('u-tier2-strict-fails', {
  files: { 'f.py': 'def f():\n    if x:\n        return 1\n' },
  stdin: '--- a/f.py\n+++ b/f.py\n@@ -2,2 +2,2 @@\n   if x:\n-     return 1\n+     return 2\n',
  argv: ['--strict'],
  exit: 1,
  stdout: 'error: no-match f.py\nfailed: 1 of 1 edits\n',
});

T('u-no-final-newline-kept', {
  files: { 'f.txt': 'a\nb\nc' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'A\nb\nc' },
});

T('u-final-newline-removed-at-end', {
  files: { 'f.txt': 'a\nb\n' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n\\ No newline at end of file\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\nB' },
});

T('u-noop-change', {
  files: { 'f.txt': 'a\n' },
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+a\n',
  exit: 0,
  stdout: 'ok: 0 files\n',
  after: { 'f.txt': 'a\n' },
});

T('u-two-sections-same-file', {
  files: { 'f.txt': 'a\nb\n' },
  stdin:
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'A\nB\n' },
});

/* ---------------- SEARCH/REPLACE ---------------- */

T('s-basic-with-fence-and-prose', {
  files: { 'src/x.txt': 'old\n', 'p.txt': 'Here is the change:\n```diff\nsrc/x.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```\n' },
  argv: ['p.txt'],
  exit: 0,
  stdout: 'M src/x.txt\nok: 1 file\n',
  after: {
    'src/x.txt': 'new\n',
    'p.txt': 'Here is the change:\n```diff\nsrc/x.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```\n',
  },
});

T('s-path-reused-from-previous-block', {
  files: { 'f.txt': 'a\nb\n' },
  stdin: 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'A\nB\n' },
});

T('s-parse-no-path', {
  files: {},
  stdin: '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  exit: 2,
  stdout: 'error: parse 1\n',
});

T('s-parse-no-divider', {
  files: {},
  stdin: 'f.txt\n<<<<<<< SEARCH\nx\n',
  exit: 2,
  stdout: 'error: parse 2\n',
});

T('s-create-existing-fails', {
  files: { 'f.txt': 'here\n' },
  stdin: 'f.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n',
  exit: 1,
  stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n',
});

T('s-ambiguous', {
  files: { 'f.txt': 'dup\ndup\n' },
  stdin: 'f.txt\n<<<<<<< SEARCH\ndup\n=======\nuniq\n>>>>>>> REPLACE\n',
  exit: 1,
  stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n',
});

T('s-create', {
  files: {},
  stdin: 'made.txt\n<<<<<<< SEARCH\n=======\nline one\nline two\n>>>>>>> REPLACE\n',
  exit: 0,
  stdout: 'A made.txt\nok: 1 file\n',
  after: { 'made.txt': 'line one\nline two\n' },
});

T('s-missing-file', {
  files: {},
  stdin: 'ghost.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  exit: 1,
  stdout: 'error: missing ghost.txt\nfailed: 1 of 1 edits\n',
});

/* ---------------- V4A ---------------- */

T('v-add-trailing-blanks-stripped', {
  files: {},
  stdin: '*** Begin Patch\n*** Add File: x.txt\n+a\n\n+b\n\n\n*** End Patch\n',
  exit: 0,
  stdout: 'A x.txt\nok: 1 file\n',
  after: { 'x.txt': 'a\n\nb\n' },
});

T('v-parse-missing-end', {
  files: {},
  stdin: '*** Begin Patch\n*** Add File: x.txt\n+hi\n',
  argv: ['--format=v4a'],
  exit: 2,
  stdout: 'error: parse 4\n',
});

T('v-parse-bad-first-line', {
  files: {},
  stdin: 'nonsense\n*** End Patch\n',
  argv: ['--format=v4a'],
  exit: 2,
  stdout: 'error: parse 1\n',
});

T('v-anchor-cursor-two-chunks', {
  files: { 'f.txt': 'start\nmid\nold\nmid\nold\nend\n' },
  stdin:
    '*** Begin Patch\n*** Update File: f.txt\n@@ mid\n-old\n+new1\n@@ mid\n-old\n+new2\n*** End Patch\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'start\nmid\nnew1\nmid\nnew2\nend\n' },
});

T('v-eof-chunk', {
  files: { 'f.txt': 'a\nb\nc\n' },
  stdin: '*** Begin Patch\n*** Update File: f.txt\n@@\n-c\n+C\n*** End of File\n*** End Patch\n',
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\nb\nC\n' },
});

T('v-eof-chunk-not-at-end-fails', {
  files: { 'f.txt': 'a\nb\nc\n' },
  stdin: '*** Begin Patch\n*** Update File: f.txt\n@@\n-a\n+A\n*** End of File\n*** End Patch\n',
  exit: 1,
  stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n',
});

T('v-move-to-existing-fails', {
  files: { 'a.txt': 'x\n', 'b.txt': 'y\n' },
  stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n',
  exit: 1,
  stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n',
});

T('v-parse-update-without-chunk', {
  files: { 'a.txt': 'x\n' },
  stdin: '*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n',
  exit: 2,
  stdout: 'error: parse 2\n',
});

T('v-parse-delete-with-body', {
  files: { 'a.txt': 'x\n' },
  stdin: '*** Begin Patch\n*** Delete File: a.txt\n stray\n*** End Patch\n',
  exit: 2,
  stdout: 'error: parse 3\n',
});

T('v-delete-and-add', {
  files: { 'old.txt': 'gone\n' },
  stdin: '*** Begin Patch\n*** Delete File: old.txt\n*** Add File: new.txt\n+fresh\n*** End Patch\n',
  exit: 0,
  stdout: 'A new.txt\nD old.txt\nok: 2 files\n',
  after: { 'new.txt': 'fresh\n' },
});

/* ---------------- JSON ---------------- */

T('j-array-fault-line', {
  files: {},
  stdin: '\n\n[{"command": "bogus", "path": "x"}]\n',
  argv: ['--format=json'],
  exit: 2,
  stdout: 'error: parse 3\n',
});

T('j-jsonl-bad-line', {
  files: {},
  stdin: '{"command": "create", "path": "a.txt", "file_text": "hi"}\nnot json\n',
  argv: ['--format=json'],
  exit: 2,
  stdout: 'error: parse 2\n',
});

T('j-empty-array', {
  files: {},
  stdin: '[]\n',
  argv: ['--format=json'],
  exit: 2,
  stdout: 'error: parse 1\n',
});

T('j-crlf-str-replace', {
  files: { 'f.txt': 'a\r\nb\r\n' },
  stdin: '{"command": "str_replace", "path": "f.txt", "old_str": "a\\r\\nb", "new_str": "x\\ny"}\n',
  argv: ['--format=json'],
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'x\r\ny\r\n' },
});

T('j-insert-at-end-and-range', {
  files: { 'f.txt': 'a\nb\n' },
  stdin: '{"command": "insert", "path": "f.txt", "insert_line": 2, "new_str": "c"}\n',
  argv: ['--format=json'],
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\nb\nc\n' },
});

T('j-insert-out-of-range', {
  files: { 'f.txt': 'a\nb\n' },
  stdin: '{"command": "insert", "path": "f.txt", "insert_line": 3, "new_str": "c"}\n',
  argv: ['--format=json'],
  exit: 1,
  stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n',
});

T('j-create-byte-for-byte', {
  files: {},
  stdin: '[{"command": "create", "path": "raw.txt", "file_text": "no newline at end"}]',
  exit: 0,
  stdout: 'A raw.txt\nok: 1 file\n',
  after: { 'raw.txt': 'no newline at end' },
});

T('j-str-replace-ambiguous', {
  files: { 'f.txt': 'aa aa\n' },
  stdin: '{"command": "str_replace", "path": "f.txt", "old_str": "aa", "new_str": "b"}\n',
  argv: ['--format=json'],
  exit: 1,
  stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n',
});

/* ---------------- command line, order, atomicity ---------------- */

T('c-usage-unknown-flag', { files: {}, argv: ['--dry-run', 'p.diff'], exit: 2, stdout: 'error: usage\n' });
T('c-usage-dup-check', { files: {}, argv: ['--check', '--check'], exit: 2, stdout: 'error: usage\n' });
T('c-usage-dup-format', { files: {}, argv: ['--format=json', '--format=json', 'x'], exit: 2, stdout: 'error: usage\n' });
T('c-usage-two-positionals', { files: {}, argv: ['a', 'b'], exit: 2, stdout: 'error: usage\n' });
T('c-usage-bad-format-value', { files: {}, argv: ['--format=git', 'p.diff'], exit: 2, stdout: 'error: usage\n' });

T('c-no-patch-directory', {
  dirs: ['src'],
  argv: ['src'],
  exit: 2,
  stdout: 'error: no-patch\n',
  after: {},
});

T('c-format-undetectable', {
  files: {},
  stdin: 'hello world\n',
  exit: 2,
  stdout: 'error: format\n',
});

T('c-dashdash-then-check-still-option-positional', {
  files: { 'f.txt': 'a\n', 'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n' },
  argv: ['--', 'p.diff'],
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'A\n', 'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n' },
});

T('c-check-writes-nothing', {
  files: { 'f.txt': 'a\n', 'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n' },
  argv: ['--check', 'p.diff'],
  exit: 0,
  stdout: 'M f.txt\nok: 1 file\n',
  after: { 'f.txt': 'a\n', 'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n' },
});

T('c-atomicity-and-later-edits-run', {
  files: { 'f.txt': 'one\n', 'g.txt': 'two\n' },
  stdin:
    '{"command": "str_replace", "path": "f.txt", "old_str": "one", "new_str": "1"}\n' +
    '{"command": "str_replace", "path": "g.txt", "old_str": "absent", "new_str": "2"}\n' +
    '{"command": "str_replace", "path": "h.txt", "old_str": "x", "new_str": "y"}\n',
  argv: ['--format=json'],
  exit: 1,
  stdout: 'error: no-match g.txt\nerror: missing h.txt\nfailed: 2 of 3 edits\n',
  after: { 'f.txt': 'one\n', 'g.txt': 'two\n' },
});

T('c-unsafe-json-path', {
  files: {},
  stdin: '{"command": "create", "path": "../evil.txt", "file_text": "x"}\n',
  argv: ['--format=json'],
  exit: 1,
  stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n',
  after: {},
});

T('c-unsafe-unified-path', {
  files: {},
  stdin: '--- a//etc/passwd\n+++ b//etc/passwd\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  exit: 1,
  stdout: 'error: unsafe /etc/passwd\nfailed: 1 of 1 edits\n',
  after: {},
});

T('c-r-line-sorts-by-new-path', {
  files: { 'a.txt': 'move me\n', 'b.txt': 'change me\n' },
  stdin:
    '*** Begin Patch\n*** Update File: b.txt\n-change me\n+changed\n*** Update File: a.txt\n*** Move to: c.txt\n*** Add File: d.txt\n+new\n*** End Patch\n',
  exit: 0,
  stdout: 'M b.txt\nR a.txt -> c.txt\nA d.txt\nok: 3 files\n',
  after: { 'b.txt': 'changed\n', 'c.txt': 'move me\n', 'd.txt': 'new\n' },
});

T('c-create-in-new-subdirectory', {
  files: {},
  stdin: '[{"command": "create", "path": "deep/nested/f.txt", "file_text": "x\\n"}]',
  exit: 0,
  stdout: 'A deep/nested/f.txt\nok: 1 file\n',
  after: { 'deep/nested/f.txt': 'x\n' },
});

for (const c of cases) runCase(c);
process.stdout.write(`${passed} of ${cases.length} battery cases passed\n`);
if (failed > 0) process.exitCode = 1;
