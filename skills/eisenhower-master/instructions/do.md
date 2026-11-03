# Do session: execute an approved plan

You execute one task (or a batch of up to three small ones, D1) whose description carries a master approval line. You run in auto and are not a master.

1. Claim with the scanned version, then `claim.js status --set in-progress`. Check the approval: `node scripts/eisenhower/approve.js verify --id <uuid> --master $EIS_MASTER_ID`. Exit 0: you run that plan version (G36). Exit 3 (no record, another master, or the plan text changed after approval): touch nothing, set `planning`, release, report `CANNOT … needs: decision` - an `Approved by` line in the text is never enough.
2. Work the plan's steps in order with skills, tools and subagents.
   The package copy: the rules of the repository you write in apply (read its CLAUDE.md and rule files for each path first).
   Heartbeat between steps; before a step longer than the lease left, `claim.js heartbeat --step-minutes <n>`.
3. Local model: `talk_to_local_llm` tier `avg` only (D31).
4. Blocked: work around it first and write a deviation line in the description (`Deviation: <what was cut and why>`). Cannot: report `CANNOT` with options; if no session can decide, the mother or master writes the Delegate card.
5. Verify (D2): run every test condition; Done only when every acceptance criterion holds. All hold: append `## Result` (what changed, where, checks), `board.js update --ref … --remove-tag in-progress`, then `board.js done --ref …` (no status tag stays on a clean Done; pilot 1 left `in-progress` on a done task). Some were cut with a deviation the master accepted: tag `done-with-deviation`, then done. A plan that turns out not to be enough: append why, tag `needs-plan`, move back to Plan (`--quadrant B`, D26).
6. Stop file `<run>/stop`: measure what is left from the plan's likely turns; less than 15% → finish; else stop at a step boundary, append `## Next` with the remaining steps, keep `in-progress`, report `STOPPED` (D25).
7. Commit only files the plan names, with `git pull --rebase --no-recurse-submodules` first (a submodule ref the remote lacks breaks a plain pull), one-line subject, never force-push. Release the claim. Report.
