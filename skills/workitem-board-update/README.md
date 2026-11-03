# workitem-board-update (independent copy)

A Claude Code skill that keeps an Eisenhower TasksDashboard board up to date from chat: add tasks and reminders, find and show them, change them, link them, mark them done, reopen or cancel them. It works through the TasksDashboard repository's own CLI, `cli/tasks.mjs`, so it follows the same rules as the board page.

## What you need

- A clone of the TasksDashboard repository (this folder is its `skills/workitem-board-update/`), Node 18 or newer.
- A TasksDashboard database (Supabase) set up from the repository's `db/` files, with an agent login (the CLI's default login, `homeos-agent`) that is an editor of the lists the skill should write.
- An env file with these names (values are never printed by the CLI, and the skill never opens the file):

| Name | What |
|---|---|
| `TASKSDB_URL` | the Supabase project URL (`https://<ref>.supabase.co`) |
| `TASKSDB_ANON_KEY` | the publishable key (never a secret or service-role key: the CLI refuses those) |
| `TASKSDB_AGENT_EMAIL`, `TASKSDB_AGENT_PASSWORD` | the agent login |

`TASKSDB_*` variables already in the environment fill names the file does not have.

## Install

1. Copy this folder to `<clone>/.claude/skills/workitem-board-update/`.
2. Start Claude Code in `<clone>` (the skill runs `node cli/tasks.mjs` from the repository root).
3. Tell Claude where the env file is the first time ("the board env file is `../board.env`"); it passes it as `--env <file>`.

## Check

```
node cli/tasks.mjs overdue --env <env file>
```

Exit 0 and a list (or nothing) means the login works. Exit 2 names the missing env names, 6 is the network, 7 a refused sign-in.

## What it does not do

- No assignee separate from the owner, no change of who is notified after a create, no catalogue of lists: the CLI has none.
- Open questions, decisions, wishes and plans are created as tasks.
- It never deletes: "delete X" sets the item cancelled.
- It never asks a question and waits: an unclear target (several matches) is listed and nothing is written.

## Switch off

Remove `<clone>/.claude/skills/workitem-board-update/`.

## Evals

[evals.md](evals.md): run them against a test list, never a real one.
