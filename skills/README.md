# Skills

Claude Code skills for this repository, for people who run the board with Claude Code. Each folder is a generated copy of a skill its author keeps in their own workspace: it calls this repository's own CLIs (`cli/tasks.mjs`, `cli/access.mjs`) and nothing outside it.

| Skill | What it does |
|---|---|
| [`workitem-board-update`](workitem-board-update/README.md) | adds, finds, shows, changes, links, closes, reopens and cancels tasks and reminders from chat, with `cli/tasks.mjs` |
| [`tasksboard-access`](tasksboard-access/README.md) | lets people into the hosted board and takes them out again (access requests, the Cloudflare Access guests policy), with `cli/tasks.mjs` and `cli/access.mjs` |
| [`eisenhower-master`](eisenhower-master/README.md) | runs the Eisenhower agent framework on the board (master, mothers, Plan, Do and Eliminate sessions, Delegate cards); its design is in `reference/agent-framework.md` |

- **Install:** copy a folder to `.claude/skills/<name>/` in your clone and start Claude Code in the clone's root. Each folder's `README.md` lists what it needs (env names, logins) and how to check it.
- **Evals:** each folder's `evals.md`; run them against a test list, never a real one.
- **Do not edit these files here:** they are regenerated whole by the author's skill build, so a change made here is lost on the next build. Suggest changes in an issue instead.
