# eisenhower-master (independent copy)

A Claude Code skill that runs the Eisenhower agent framework on a TasksDashboard board: a daily master session scans the board, starts one mother session per list, the mothers start Plan, Do and Eliminate sessions, and every task's state is visible on the board (status tags, claims, plans and results in the task's description). A task that needs the person becomes a Delegate card. The design and its decisions D1-D34 are in [reference/agent-framework.md](reference/agent-framework.md), a snapshot rendered from the author's own design file on every build.

## What you need

- A clone of the TasksDashboard repository (this folder is its `skills/eisenhower-master/`), Node 18 or newer, Claude Code with the `claude` command on the PATH (sessions below the master are headless `claude -p` processes).
- A TasksDashboard database with an agent login that is an editor of the lists the framework works, and a tag list "Status" with the status tags the skill names (`needs-plan`, `planning`, `plan-approved`, `in-progress`, `blocked`, `needs-person`, `done-with-deviation`, `eliminate-proposed`).
- The env names of `cli/tasks.mjs`: `TASKSDB_URL`, `TASKSDB_ANON_KEY`, `TASKSDB_AGENT_EMAIL`, `TASKSDB_AGENT_PASSWORD` (the repository README, "CLI").
- **The helper scripts the instructions call are not in this repository yet:** `scripts/eisenhower/scan.js` (list snapshot, readiness, Eliminate suspects, diff), `approve.js` (plan approval record with a plan hash, and its check), `claim.js` (claim lease, heartbeat, status tag, Delegate), `rank.js` (placing a card in its quadrant) and `spawn.js` (starting and waiting for headless sessions). Until they ship, use this copy as the framework's operating manual: run the roles by hand, or build those helpers to the contracts the instructions describe. Board reads and writes go through `node cli/tasks.mjs` (SKILL.md, "Tools", the package-copy row).

## Permissions

The master works without a person for a whole day, so the owner gives the master session a written permission grant before the first run: what it may decide alone (accept a smaller result with a deviation, reorder plan steps, grant a session a named file edit, apply a migration an approved plan names) and what it never does (paid services, purchases, messages to anyone but the owner, deleting anything, editing settings or permission files, publishing). The sessions the master starts run in auto mode and do not inherit the grant.

## Install

1. Copy this folder to `<clone>/.claude/skills/eisenhower-master/`.
2. Create a scheduled task named `eisenhower-master` whose prompt starts with `role: master` and names the inputs of `instructions/master.md` (`window_start`, `wrap_up`, `lists`, `max_live`, `cycle_minutes`, `only`, `exclude`) and the runs folder.
3. Try it on a test list first (evals below).

## What it does not do

- Never asks a question card: what only the person can decide becomes a Delegate card on the board.
- Never cancels or deletes: Eliminate only proposes, the person cancels.
- Never spends money, buys, messages anyone but the owner, or edits settings or permission files.

## Switch off

Disable the scheduled task, or write `<run>/stop` to end the current day early; remove `<clone>/.claude/skills/eisenhower-master/` to remove the skill.

## Evals

[evals.md](evals.md).
