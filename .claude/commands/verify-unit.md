---
description: Run read-only verification checks for the current build unit (typecheck, tests, diff scope) — reports only, never fixes anything
argument-hint: [expected-scope paths/globs for this unit]
allowed-tools: Bash(npx tsc --noEmit), Bash(npm test), Bash(git diff --name-only)
---

# Verify Unit

Run exactly the three checks below, in order. This command reports results — it must never fix, edit, or modify anything, and never re-run a check after changing something.

**Argument given:** $ARGUMENTS

Resolve the expected scope for Check 3 from that argument before running it:

- **No argument at all** — ask the user which paths/directories this build unit is expected to touch before running Check 3. Do not guess at it.
- **A bare integer** (e.g. `7`) — this refers to item #<N> in the numbered list in `build_sequence.md`, not a literal scope string. Read `build_sequence.md` to identify that unit's name/description, then read CLAUDE.md's "Architecture" section, which maps each build_sequence.md unit number to the specific directories/files it owns (e.g. unit 1 → `src/types/provider.ts`, unit 3 → `src/sync`, unit 6 → `api/v1/*`, unit 7 → `tests/`). Use that mapping as the expected scope. If CLAUDE.md has no mapping for that unit number, fall back to asking the user — do not guess.
- **Anything else** (a literal path, glob, or list of paths) — use it directly as the expected scope, unchanged.

## Check 1 — Type check

Run:
```
npx tsc --noEmit
```
- Exit code `0` → report "Check 1: PASS — `tsc --noEmit` exited 0."
- Non-zero → report "Check 1: FAIL" and list every reported type error verbatim (file, line, message).

## Check 2 — Tests

Run:
```
npm test
```
- Report the pass count, fail count, and the full text of every failure message verbatim — do not summarize or paraphrase failures away.
- If the command itself fails to run at all (missing script, crashed runner, etc.), report that as a Check 2 failure with the exact error output.

## Check 3 — Diff scope

Run:
```
git diff --name-only
```
- List every file it reports as modified since the last commit.
- Compare each path against the expected scope given above. Name, individually, every file that falls outside that scope.
- If no expected scope was available (and the user had none to give when asked), skip the scope-flagging step and just list the modified files, noting that scope wasn't checked.

## Verdict

End with exactly one of the following:

- `UNIT VERIFIED` — only if Check 1 exited 0, Check 2 reported zero failures, and Check 3 found no files outside the expected scope.
- `UNIT FAILED` — followed by a bullet list naming exactly which check(s) failed and why (the specific type errors, the specific failing test names/messages, or the specific out-of-scope file paths).

Do not attempt to fix anything this check turns up. Reporting the failure is the entire job.
