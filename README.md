[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oy-builds/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oy-builds/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

An entry for make.fun's **hidden-spec-cli-01** bounty ("Build mend, one patch
tool for every AI edit format").

`mend` is a zero-dependency Node 22 command-line tool that applies an edit an
AI model wrote to a tree of text files. Models write edits in four formats, and
mend reads all of them to the one specification in [SPEC.md](SPEC.md):

- **unified diffs** — including hunks whose line numbers are wrong: the hunk's
  lines are located by content, nearest to where the header claims they are;
- **SEARCH/REPLACE blocks** — the `<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE` form;
- **V4A patches** — `*** Begin Patch` … `*** End Patch` with Add / Delete /
  Update File sections, anchors and moves;
- **JSON tool calls** — `create`, `str_replace` and `insert` edit objects, as
  one JSON array or as JSON Lines.

Old lines are matched at the first of three tiers that finds them: exact,
ignoring trailing whitespace, then ignoring leading whitespace too (with
re-indentation of the replacement at that tier). `--strict` pins matching to
the exact tier. Every edit in a patch applies, in order, or — when any edit
fails — nothing is written at all and every failure is reported.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file relative to the working directory (the root of the
tree); with no `PATCH`, or `-`, the patch is read from standard input.
`--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto`
(the default) to detect the format. `--check` reports what would change
without writing anything.

Exit codes: 0 when every edit applied (the changed paths are listed, then
`ok: <n> files`), 1 when one or more edits failed (one `error: <code> <path>`
line each, then `failed: <k> of <n> edits`, and no file is written), 2 for a
usage error, an unreadable patch file, an undetectable format, or a patch
that does not parse in its format.

## Layout

- `main.ts` — the CLI itself (SPEC.md sections 1–10).
- `runner.ts` — the kit's trial runner, kept as the kit ships it: when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.
- `check.ts` — the kit's practice checker: `node check.ts <practice.json>`
  runs `main.ts` over the public practice checks.
- `tests/` — an independent test battery (plain Node, no dependencies):
  `node tests/run.mjs`.
