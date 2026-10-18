---
description: Run read-only verification checks for the current build unit (typecheck, tests, diff scope) — reports only, never fixes anything
argument-hint: [expected-scope paths/globs for this unit]
allowed-tools: Bash(npx tsc --noEmit), Bash(npm test), Bash(git diff --name-only)
---

# Verify Unit

Run exactly the three checks below, in order. This command reports results — it must never fix, edit, or modify anything, and never re-run a check after changing something.

**Expected scope for this unit:** $ARGUMENTS

If no scope was given above, ask the user which paths/directories this build unit (per `build_sequence.md`) is expected to touch before running Check 3 — do not guess at it.

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
