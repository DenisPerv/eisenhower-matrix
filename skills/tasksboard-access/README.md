# tasksboard-access (independent copy)

A Claude Code skill that lets people into a hosted TasksDashboard board and takes them out again. A person asks for access on the board's sign-in page; the database files a task for the request; the owner says "approve X" in chat; the skill writes the decision on the task and applies it with `cli/access.mjs` (Cloudflare Access guests policy, the decision in the database, the task closed). Every step that changes something is a dry run first and waits for the owner's yes.

## What you need

- A clone of the TasksDashboard repository (this folder is its `skills/tasksboard-access/`), Node 18 or newer.
- The hosted board behind Cloudflare Access, set up once by a person as `docs/access-requests.md` and `docs/hosting.md` describe (`node cli/access.mjs setup` or `setup --gate`, which the skill never runs).
- A TasksDashboard database with the access requests (`db/015`) and an agent login that is an editor of the list `access-requests`.
- An env file with these names (the CLIs print names only, never values; the skill never opens the file):

| Name | What |
|---|---|
| `TASKSDB_URL`, `TASKSDB_ANON_KEY` | the Supabase project URL and its publishable key |
| `TASKSDB_AGENT_EMAIL`, `TASKSDB_AGENT_PASSWORD` | the agent login |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account |
| `CLOUDFLARE_ACCESS_TOKEN` | a token with Account → Access: Apps and Policies → Edit |
| `CF_ACCESS_PROD_APP_ID` | the Access app that guards the board (in the two-host layout, the gate app) |
| `CF_ACCESS_GUEST_POLICY_ID` | the guests policy, printed by `access.mjs setup` |

## Install

1. Copy this folder to `<clone>/.claude/skills/tasksboard-access/`.
2. Start Claude Code in `<clone>` (the commands run from the repository root).
3. Tell Claude where the env file is; it passes it as `--env <file>`.

## Check

```
node cli/access.mjs list --env <env file>
```

It prints the guests policy's emails and seats. Exit 2 names missing env names, 7 a refused token or login, 6 the network.

## What it does not do

- No emails to requesters and no daily routine: approvals and declines happen when the owner asks in chat.
- It never runs `setup`, never passes `--force` without the owner's yes, never deletes anything.

## Switch off

Remove `<clone>/.claude/skills/tasksboard-access/`.

## Evals

[evals.md](evals.md): run the dry-run steps for real and `--apply` only where the scenario gives a yes, against test addresses (`@example.com`).
