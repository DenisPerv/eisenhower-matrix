---
description: Eisenhower for agents - the product vision of the agent framework behind the Eisenhower board (a personal time manager that is also a harness for a swarm of Claude agents, for a manager who works in Claude Code through the Claude app on a subscription, not on API money), what each quadrant means for agents, and the Delegate concept (a future decision-maker agent; today a mix of people and agents); stage 1 of the solution design, 2026-10-29
---
> Snapshot of the Eisenhower agent framework design, rendered from its author's own design file by the skill build. Paths in the author's workspace are generalised: the workspace is called "the owner's workspace" and its two agent lists "Agent tasks" and "Agent Detailed". Regenerated on every build; never edit it here.

# Eisenhower for agents: framework vision

Status: draft, design stage 1 (listen and structure), 2026-10-29. Written from the owner's own description; the mechanics (sessions, lanes, guards) are added at the design stage. The landing page and its demo are in README.md.

The full working design with diagrams, proposals P1-P8 and the hazard review v2 is the private Claude artifact "Eisenhower Agent Framework" (a private link, version 1, 2026-10-29). This file stays the source of truth for decisions.

## 1. What we are building

One board that does two jobs at once:
- **a personal time manager:** the Eisenhower matrix for the person's own work;
- **a harness for a swarm of agents under the hood:** the same board steers the agents that plan and do the work, and shows what they are doing.

The matrix is old. This is its version for an agentic environment.

## 2. Who it is for

| | |
|---|---|
| User | an experienced manager who already works in Claude Code through the Claude app |
| Constraint | no unlimited money for API calls. The user works through the Claude app on a subscription, so plan usage, not an API bill, is the budget |
| Why a board | it is a simplified interface for multi-threaded work: the manager steers many parallel streams from one place instead of juggling sessions by hand |

## 3. Hypothesis

With this tool the manager can parallelise their work significantly.

## 4. How the user works with it

1. The user writes a **product task** on the board.
2. Agents **decompose** it and **plan** it.
3. When something is unclear, an agent **creates a task asking the user to clarify it in a named session inside the Claude app**. The user answers there.
4. Agents **execute end to end** without the user.

What the user can see and control through the board:
- take part in a **planning session** directly;
- watch how an **implementation session** runs;
- see how **context is spent**;
- control which **routines** run, to trigger processes, to analyse access rights and more.

## 5. The matrix for agents

The classic matrix sorts by two questions. The board app already implements it (`Views/TasksDashboard/README.md`, Model):

| Quadrant | Important | Urgent | Classic verb | Agent version |
|---|---|---|---|---|
| A Do | yes | yes | do it now | executed by agents now |
| B Plan | yes | no | schedule it | planned by agents |
| C Delegate | no | yes | hand it off | handled by another workflow that runs agents (see 6) |
| D Eliminate | no | no | drop it | removed: duplicates of itself with older dates, and extra load that can be avoided ("time frogs") |

Limited resources are the point: a person has hours in a day; the agents have a usage budget. Part of the work is done, part is planned, part is handed off, and part is dropped because it brings no direct value.

## 6. Delegate

- **Target:** Delegate means another workflow that starts agents to solve the problem. In the ideal case a future **problem-solver / decision-maker agent** looks at the items in Delegate and acts as a person would: it changes the plan when needed, moves items to Eliminate when needed, and decides the next step.
- **Today:** that agent does not exist yet. Delegate is a mix of people and other agents.
- **Not decided yet:** when agents pick up items from Delegate. Proposals are part of the design review.

## 7. Decisions, interview round 1 (2026-10-29)

| # | Question | Decision (the owner) |
|---|---|---|
| D9 | What a quadrant means | **Importance × urgency, as in the classic matrix.** The agents' progress lives in the item's tags: status, owner and the rest of the fixed vocabulary, so anyone can see how far a task has got. Mother and child sessions update them. After the master's scan, the mother sets the first status (for example: this task needs planning) and starts a session that plans it |
| D11 | Who runs the day | **The master is a scheduled routine session for the working day.** It starts in the morning (for example 09:00), takes a number of tasks, then alternates work and sleep cycles. At midnight it stops and reports the day's results from a scan of the board. It runs locally in the Claude app, not in the cloud, so it starts child sessions itself. To verify first: the planning protocol notes that the app refuses session starts from scheduled turns |
| D10 | Where an agent puts a task that needs the person | **In Delegate, in its own list, with the person as owner.** When the person reviews the lists, they see it among their own tasks. Delegate tells them: I handed this off, go and check where it stands |
| D13 | How much the master may decide | **The master decides without a person.** It approves plans and grants permission to edit specific files such as `.env`. Escalations to the master should be rare: a mother works around a blocker first (if a test was meant to run with two users and could run with one, one is accepted). No security by obscurity: the goal is finished work. Bypass permissions stays until auto mode plans well or the master can approve plans. The level-up routine validates the automated work and improves it in iterations |
| D14 | Who decides what is important | **Two filters.** Primary (code): within a quadrant, first in, first out by creation date, then corrected by deadline: items whose deadline falls inside the person's urgency threshold (stored in the database) go first. Secondary (LLM): reads the person's finished work and their big product goals, finds the tasks still missing to finish a goal, and raises the focus on finishing it. The point of the app is that Claude keeps the person on the principal tasks |

**Reference case for D14:** "Make a game: from market research to one tested prototype" (Agent tasks #1, Do). The person writes one product task with its stages. When an agent picks it up from Do and plans it, it breaks the description into product tasks, sets the dependencies between them, and, from the stage the person has reached, keeps showing why finishing it matters.

**Dependencies between tasks** are a separate feature of the board; the owner asks another session for it.

## 8. Decisions, interview round 2 (2026-10-29)

| # | Question | Decision (the owner) |
|---|---|---|
| D15 | What the master never does alone | **Subscribe to a paid service.** When a paid service looks unavoidable, the master first has the mother check: is there a free solution, what does it cost us, and how hard is it to move to the paid one later. A free local solution is fine as long as moving to production does not mean rebuilding the project. If paid is unavoidable, the task goes to Delegate |
| D16 | When agents pick up Delegate items | **Not decided.** There is no understanding yet of how to build the decision-maker agent at this level. For now every Delegate item goes to a person |
| D17 | Eliminate in the first version | **Agents only propose.** The item stays in Eliminate, assigned to the person, who makes the final call. Its description states a clear reason why it is there; a proposal without one is not accepted |
| D18 | How a blocked task reaches the person | **A planning session that waits for an answer:** the person goes into that session and continues there; when the session ends, it moves the task to the right state. **A task stuck outside Plan:** escalates child → mother → master; if no decision is made, it moves to Delegate. **Every Delegate item** names the session where the blocker happened and the dependency on the person, ideally with the concrete context and the question to decide; the question and the session name are in bold |
| D19 | Small tasks and where plans live | **The board holds business and product tasks only; agents do not add small tasks.** A session writes its plan into the task's description and keeps it in the session too. When a plan moves to implementation, an implementation sub-session is created from it, so the person can always find how it is being done. The plan session is the synchronisation point for everything that executes the plan. Structure: master → mother (one per list) → quadrant session (for example Plan) → the Do quadrant creates sub-sessions for the tasks that came from Plan |

**After round 2:**

| # | Question | Decision (the owner) |
|---|---|---|
| D20 | What the master's rights are | **The permissions review of 2026-10-28 is the master's permission list** (a run folder, proposal section 4). Auto mode keeps its defaults and adds: environment entries (the owner's workspace as a trusted repo with its submodules, the owner's sibling projects, secrets only in the private env file, the household's free-tier services, the board's first Pages project) and allow rules (the TasksDashboard deploy to the board's first Pages project, stopping local dev servers a session started, reading the private env file, planned TasksDashboardDB migrations), plus allow rules for the app's session tools. What the review keeps blocked stays blocked: handing out a credential (`wrangler login`), publishing an OAuth consent screen, a session editing its own settings, and the five rejected actions |

| D21 | How planning works | **Top down, always.** A plan starts from the goal to reach and the result expected, and only then breaks into steps. Every step says which part of the result it brings |

**Round 3 (2026-10-29):**

| # | Question | Decision |
|---|---|---|
| D20a | Where the master's permission list lives | **`master-session-permissions.md`** (renamed from `max-possible-permissions.md` on 2026-10-29; part of the planning framework, it opens with what happens and why). It is the one file the person names when they hand work over ("work without me"); it now holds the D20 settings (session tools, the auto mode block) as well. It counts only when the person names it in that session (the owner) |
| D22 | Cloudflare tokens and other credentials for later sessions | **CLI sign-in first, a token only when unavoidable** (Claude decided, at the owner's request). Most Cloudflare work goes through `wrangler` or `cf`, signed in once by the person, with no token. A static token: the master prepares it in the person's Chrome (page, name, scopes, expiry), the person presses Create and copies the value, a local script writes it into `.env` behind a hidden prompt. The value never passes through chat, screenshots or logs. Reason: Claude's browser rules need a yes at that moment for account security changes |
| D23 | Migrations that change database access rules | **Allowed for the master,** on a plan it approved itself. The mother does not get this right (the owner) |
| D24 | When bypass starts | **From the first run** (the owner). The master runs in bypass; the sessions it starts run in auto, as the planning protocol requires, and do not inherit the master's grant |
| D11 (rev.) | The working day | **A routine starts the master at a set time (for example 01:00).** The master closes the day by 23:50: every task is brought to a stopping point, its plan is updated, its documentation is done, the board is updated. The next run picks up the current tasks from the board. Only the master has a time window; the other sessions work until their work is done or the master says to stop. At the stop, the current task is brought to a stopping point and the rest becomes plan items for the next run. This imitates a colleague's working day (the owner) |
| D25 | Finish or stop a child's task at the stop signal | **Finish it when less than 15% of its work is left** (the owner). Measured from the task's plan (Claude): the likely turns of the steps not yet done, against the plan's total |

**Round 4 (2026-10-29):**

| # | Question | Decision |
|---|---|---|
| D26 | What a quadrant means when agents move cards (refines D9) | **Importance × urgency, and the global stage of a task or a group of tasks** (the owner). Inside a quadrant the work state lives in the status tags. An agent moves a card to another quadrant only when its stage changes: a task blocked for good goes to **Delegate**; a task whose plan turns out not to be enough goes back to **Plan**. With D17 (proposed drop goes to Eliminate) and D19 (an approved plan goes to Do), those are the only moves agents make |
| D27 | How framework sessions plan | **Outside plan mode, but every planning requirement still applies** (the owner): a worked-out plan, a review of what went wrong, risks, dependencies, decomposition into tasks, the number of requests each needs, and context management. The master's approval is a record on the task with the plan version |
| D28 (rev.) | The order of tasks inside a quadrant | **The system ranks, the person reorders; the position is the only priority** (the owner supports the ranking, rejects a pin field). The rank rule: deadline inside the person's threshold first (earliest deadline first), then creation date (first in, first out). The system applies it only when a card arrives (an agent places it where the rule says) and when a card's deadline enters the threshold (that card moves up); it never re-sorts the whole quadrant. So a card the person dragged stays where they put it, with no extra field. Few new business tasks arrive, so this holds. This is not LIFO: newest-on-top is what the app does with new cards |
| D29 | Models | **Opus for every framework session** (the owner). An Opus session may start sessions on weaker models and may call the local LLM MCP (tiers small, avg, strong) for code and for decision making. It picks the tier from the tier descriptions. Loading a model is expensive (one fits in GPU memory, a swap takes 60-90 s), so when the loaded model can do the job, it uses that one |
| D30 | Which lists the framework works | **The owner's workspace creates tasks in every list; framework agents take tasks only from "Agent tasks" and "Agent Detailed"** (the owner). "Agent Detailed" is the agents' own working list: agents use it as they need, the person does not manage it. D19 (no small tasks on the board) applies to the lists the person manages (Claude's reading). **Not designed yet; for now it only exists.** The idea (the owner): a synchronisation point between sessions for agents. Example: a "local LLM" session plans an extension; the Agent tasks list gets the product steps (find current models and propose replacements, justify the change, plan the implementation, test, deliver with updated docs); Agent Detailed gets the working tasks behind them (model searches with different parameters, comparisons, wider research, intermediate results such as the implementation plan) that have no place of their own among the product tasks but feed one directly |
| D31 | Local models in the first version (replaces the tier choice in D29 and refines G40) | **One local model for every use: Qwen (the `avg` tier)** (the owner). One model means no swaps and no conflicts between sessions. Framework sessions call only `avg`; if another model happens to be loaded, they swap to Qwen once |

**Before the build (2026-10-29):**

| # | Question | Decision |
|---|---|---|
| D32 | Who is a master and holds `master-session-permissions.md` | **A session named master at start (by the person, by a routine the person created and confirmed, or by a master), a session the person asks to become master, or a session a master starts as a master** (the owner: "Мы это делаем для того, чтобы рутины могли создавать мастер сессии, и мастер сессии назначали сами себе нужные права. Без вовлечения пользователя"). Masters may run in bypass. Claude's reading, to keep D23 and D24: a session a master starts as a mother, quadrant or task session is not a master and runs in auto; renaming itself later gives a session nothing. A routine the person created and confirmed, whose prompt names the file, carries the grant for its runs |
| D17a | Eliminate proposals | **A plain-language description of the reason, not a code** (the owner). Replaces the reason codes of G39 |
| D33 | Session topology, from spike S1 (2026-10-29) | **T3 headless** (chosen by the pre-agreed rule of `v1-build-plan.md` T6, no person). Evidence (a run folder, a run folder): (a) the scheduled run of `eisenhower-master` (bypass, Opus) has no `start_session` tool at all, so it cannot start app sessions; (b) a session that another session started is refused by the app ("Start sessions only on the user's own words…"); (c) a subagent from the scheduled run works; (d) a headless `claude.exe -p --permission-mode auto --model opus` works from the scheduled run and from a started session (exit 0, about 9 s). **Consequences:** the master starts mothers, and mothers start quadrant and task sessions, as headless `claude -p` processes through `scripts/eisenhower/spawn.js` (auto mode, Opus, a prompt file, a timeout, output and session id in the run folder). They do not show in the Claude app's sidebar; their transcripts are `~/.claude/projects/D--Claude-Personal-the owner's workspace/<session-id>.jsonl`, and the person continues one with `claude --resume <session-id>` in a terminal opened in the repo, so a Delegate card names the session id and that command (D18). A headless session runs one turn: it cannot be messaged while it runs, so parents and children talk through the board (claims, status tags, the task's description) and report files, not `SendMessage`. Capacity (D4) is counted by `spawn.js` from the live processes it started. The vision "watch the sessions in the app" waits for the app to let scheduled sessions start sessions; re-run S1 when the app changes |
| D34 | Build plan and sessions | **v1-build-plan.md** in this folder: spike S1 first (it decides the session topology, recorded as D33), then board scripts, master rules, skill and routine, pilot 1 on `_selftest`, pilot 2 on Agent tasks #1, docs, the daily schedule. Two worker sessions: `eis-core` (scripts) and `eis-frame` (spike, rules, skill, pilots, docs) (the owner: "разбей работы по сессиям") |

## 10. Build results (v1)

- **Spike S1, 2026-10-29:** see D33 (headless topology).
- **Pilot 1, 2026-10-30, `_selftest`** (run a run folder, master local_4082cc49, bypass, Opus): started 01:15, closed early at 01:25 with nothing pickable; 5 headless sessions (mother, plan, two do, eliminate), peak 5 live of 6. Board checked against the expected table: empty task → plan v1 template plus a Delegate card ("what, for whom, by when"); approved task → executed, `hello.txt`, done; taste choice → do session CANNOT, mother wrote the Delegate card; older duplicate → Eliminate proposal with a plain reason naming the newer task. No lease left behind. Gaps fixed after it: a done task kept `in-progress` (do.md now clears it), `spawn.js` turned `_selftest` into `-selftest` (underscores kept now), children skipped the startup sync on their own (SKILL.md now says only the master syncs).
- **Fixes 1, 2, 5, 7 (2026-10-30, the owner: "Yes, do 1, 2, 5, 7"):** the D27 approval record is now `items.ai.approval` {by, plan_version, plan_hash, at} written by `scripts/eisenhower/approve.js`, and a Do session runs only after `approve.js verify` (pilot 1 had trusted a seed-written description line); `only:`/`exclude:` settings; a ready plan without a valid approval is tagged `planning` for the master; `git pull --rebase --no-recurse-submodules`. Residual risk: `items.ai` is writable by people and the agent login.
- **Pilot 2 (Agent tasks #1):** skipped (the owner, 2026-10-30: enable the daily schedule now; the first real day on Agent tasks is the second pilot). Daily schedule `0 1 * * *` enabled 2026-10-30.

## 9. Open questions

- When agents pick up items from Delegate (section 6, D16).
- The mother session's rights (plan item; the master's are settled in D20, D20a, D22-D24).
- A local script that writes a pasted secret into `.env` behind a hidden prompt (D22; does not exist yet).
- Spike S1: answered 2026-10-29 (D33, headless). Re-run it when the Claude app changes how scheduled sessions start sessions.
- Design the "Agent Detailed" list (D30): what goes there, who closes it, how it links to its the owner's workspace task; then create it.
- A section in the planning protocol for framework sessions that plan outside plan mode (D27). In the build plan (T7).
- Hardening: a master in bypass follows `ROUTINE.md` and the skill, which any session with repo write can edit; the master should check them against the last approved commit (build plan review row 19).
- How the user is pointed to "the named session inside the Claude app" from a task, and how that session continues after the answer (section 4).
- Which tasks agents put on the board: only business and product tasks, technical tasks stay inside a task's plan (from stage 1).
