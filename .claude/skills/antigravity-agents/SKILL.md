---
name: antigravity-agents
description: Orchestrate Google Antigravity CLI (agy) sub-agents running Gemini 3.8 Flash as a parallel build crew. Launch tracked agy sessions, run them in isolated git worktrees, watch them live with a Sonnet monitor agent, track quota across heavy sessions, and merge their work. Use whenever the user mentions agy, Antigravity, Gemini workers or sub-agents; asks to delegate, offload, fan out, or "get more done in parallel"; wants a whole app or feature built by agy agents that Claude orchestrates; wants a second-model review; or asks about agy usage or limits.
---

# Antigravity sub-agents

You are the lead: architect, dispatcher, and integrator. `agy` workers running Gemini 3.8 Flash are the crew. They run fully autonomously with every permission granted. They can read, write, and run anything in their working directory, including building, testing, installing, committing, and searching the web. Any piece of work can go to them, up to a whole application. What you add is the plan, the briefs, the merging, and checking that the result works.

## The controller

Every job goes through `agyctl`, which lives in this skill (path relative to the project root):

```bash
AGY=.claude/skills/antigravity-agents/scripts/agyctl
```

| Command | What it does |
|---|---|
| `$AGY launch <job> [--worktree] [-C dir] [--model m] [--resume job] <<'EOF' … EOF` | Starts a detached agy session with the brief on stdin. Prints the conversation ID. |
| `$AGY status [-v] [jobs…]` | Table showing state (running/stalled/done/failed/dead/stopped), elapsed time, idle time, steps, tokens, and current activity |
| `$AGY log <job> [-n 40] [--outputs 400]` | Readable feed of the job's tool calls and messages |
| `$AGY result <job>` | The job's final response, status, branch, and conversation ID |
| `$AGY watch [--key k] [--max 540]` | Blocks until a job finishes, fails, stalls, or errors, or quota runs low. Then reports. |
| `$AGY usage` | Gemini 5-hour and weekly quota left, reset times, and agyctl token totals. Exits 10 on warn (<25%) and 11 on critical (<10%). Uses no quota. |
| `$AGY stop <job>… \| --all` | Kills the job's whole process tree. The conversation can be resumed later. |
| `$AGY clean <job>… \| --finished [--delete-branch]` | Removes job directories and their worktrees |
| `$AGY models` | Lists agy models and what the default resolves to |

Under the hood, each job runs `agy -p <brief> --output-format stream-json --dangerously-skip-permissions --model <m>` with stdin closed. It is detached with `setsid`, and its live events go to `~/.local/state/agy-runs/<job>/`. The controller handles every flag that has bitten earlier setups: see "Gotchas".

## Model

The default is `flash`, meaning the newest **Gemini Flash (High)**. agyctl finds it in `agy models`, so today it resolves to `gemini-3.8-flash-high`, and it moves to a newer Flash automatically when one ships. Use `--model flash-medium` for simple mechanical jobs (renames, boilerplate, formatting) to save quota. Only use Pro, Claude, or GPT models inside agy if the user asks.

## Starting a session

1. Run `$AGY usage`. This confirms agy is signed in and shows how much quota is left. If it shows a sign-in URL or an auth error, the user has to run `! agy` once and finish the Google sign-in in the browser. You can't do that for them.
2. For write jobs the target must be a git repo with at least one commit. If it isn't, run `git init`, add a `.gitignore`, and make an initial commit. Tell the user you did this.
3. Launch jobs (below), then start the monitor ("Monitoring" below).

## Launching

```bash
$AGY launch prefs-ui --worktree <<'EOF'
<self-contained brief>
EOF
```

- `--worktree [branch]` creates a fresh git worktree on the branch `agy/<job>` from `HEAD` (or from `--base <ref>`) and runs the job in it. Use it for **every job that writes while other writers are running**, you included. Jobs working in their own worktrees can't collide.
- Without `--worktree`, the job runs in `-C <dir>` or the current directory. That's fine for analysis, research, and reviews, and for a single writer while you aren't editing the same tree.
- `--resume <job>` continues that job's agy conversation, keeping its full context, in its directory and branch. Use it for follow-ups and fixes: "tests X and Y fail with <output>; fix them". Never use raw `agy --continue` while several jobs are running, because "most recent" is ambiguous.
- `--schema '<json schema or file>'` makes the final answer structured JSON. This is useful for review findings.
- `--timeout 45m` adds a hard cap. The default is none: agy runs until the turn completes.
- `--add-dir <path>` grants access to extra directories. `--agent <name>` runs one of agy's custom agents.

Tell the user roughly how long a job should take. Small tasks take under a minute, features take 5–20 minutes, and large slices can take longer.

## Writing the brief

The worker knows only what's in the brief and in the repo. Include:

1. **Goal**: what to build or change, concretely, with acceptance criteria.
2. **Context**: "Read `AGENTS.md` first" (see the playbook), then the relevant paths, entry points, and interfaces it must implement or consume.
3. **Ownership**: the files and directories this job owns. Parallel jobs need non-overlapping ownership, or their merges will conflict.
4. **Definition of done**: the exact build or test commands that must pass, plus "commit your work on this branch with clear messages".
5. **Report**: what the final message must contain, such as a summary, files changed, commands run and their results, known gaps, and follow-ups. The final message is all you get back.

## Building a full application

1. **Spec (you).** Write `AGENTS.md` at the repo root. Cover the product goal, stack, directory layout, module boundaries, shared types and interfaces, conventions, and the build, run, and test commands. Commit it. Every brief points at it, so the whole crew builds to one design.
2. **Scaffold.** Set up the skeleton, shared contracts, build config, and a trivial passing test. Do it yourself or with one job, then commit. Parallel work only merges cleanly once the contracts are fixed.
3. **Slice.** Split the work into units with disjoint file ownership (per module, feature, or screen), each with its own acceptance commands.
4. **Wave.** Launch the slices with `--worktree`, starting with 4–6 at once and scaling up while quota allows. Then spawn the monitor.
5. **Integrate as jobs land.** Check `$AGY result <job>` and `git log/diff` on `agy/<job>`, then `git merge agy/<job>` into the main branch. Resolve conflicts yourself, and run the full build and tests on the merged result. Fix small breakage yourself. Send larger breakage back with `--resume <job>` and the exact failing output. Then run `$AGY clean <job> --delete-branch`.
6. **Next wave.** Commit first, since new worktrees branch from `HEAD`. Repeat until the features are done.
7. **Harden.** Run fresh (non-resumed) review jobs per area for independent eyes, using `--schema` for findings. Triage the findings yourself, then send a fix wave.
8. **Finish.** Do the full build and test run, and a real run of the app where possible (the `run` skill helps). Then report to the user what was built, by which jobs, and what you verified.

A single agy job can also fan out on its own (agy has built-in subagents), so one big brief is an option for a self-contained area. Parallel worktree jobs give you better visibility and control.

## Monitoring

**Sonnet monitor agent.** After launching a wave, spawn `agy-monitor` with the Agent tool: `subagent_type: "agy-monitor"`, run in the background. In its prompt, list the jobs, one line each on what they should be doing, and whether it may stop looping, stuck, or over-quota jobs. It watches every job plus the quota and returns a short report as soon as something needs you: a job finished, failed, stalled, or drifted off the brief, or quota is running low. Act on the report, then spawn it again (or `SendMessage` to continue it) while jobs are still running. Run one monitor per fleet. It covers all jobs and usage.

If `agy-monitor` isn't in the list of agent types, the session started before the agent file existed. Use `subagent_type: "general-purpose"` with `model: "sonnet"` instead, and begin the prompt with "Read `.claude/agents/agy-monitor.md` and act as that agent, following its instructions exactly".

**Yourself.** `$AGY status` and `$AGY log <job>` are cheap, so check them any time. To be woken up without the monitor, run `$AGY watch --key lead` with `run_in_background`. Use your own `--key` so you don't consume the monitor's events.

What "stalled" means: agy writes an event for every tool call, so 10+ minutes of silence (`AGY_STALL_MIN`) means a long command such as a dev server or a watcher, or a hung model. Check `$AGY log <job>`. If the job is blocked on a foreground server, stop it and resume with "run servers in the background".

## Usage and limits

All Gemini models share one **5-hour** bucket and one **weekly** bucket. Usage is charged in proportion to token cost. `$AGY usage` reads the live numbers from agy's `/usage` at no cost. The watch loop and the monitor check them every 2 minutes and report `QUOTA_WARN` below 25% and `QUOTA_CRIT` below 10%. The thresholds can be changed with `AGY_QUOTA_WARN` and `AGY_QUOTA_CRIT`.

Heavy-session policy:
- Check `$AGY usage` before each wave.
- **OK**: launch freely.
- **WARN**: let running jobs finish. Only launch jobs on the critical path, prefer `flash-medium` for simple work, and tell the user.
- **CRIT**: don't launch anything. Let running jobs finish, or stop them if they're far from done. Tell the user when the bucket resets (`usage` shows the time), and do the integration work yourself in the meantime.
- Keep costs down. Resumed conversations re-read their whole history, so when a conversation gets long, start fresh with a new brief that summarizes the state. Keep briefs focused and slices narrow, and don't make jobs rediscover things you can tell them.
- API failures exit with code 3 and an `AGY_ERROR` line (`$AGY status` shows it) that includes whether the error is retryable. For rate-limit or 5xx errors, wait a bit, then use `--resume` so work isn't lost.

## Verifying

A job saying it's done doesn't prove anything. Before merging or reporting: read `result`, look at the diff, and run the build and tests yourself on the merged tree. Tell the user what the workers did, what you verified, and what you corrected.

## Gotchas (all handled by agyctl, listed for raw `agy` calls)

- **Stdin must be closed** (`</dev/null`). Otherwise agy hangs forever with no output.
- **Headless permissions:** without `--dangerously-skip-permissions`, every tool call is auto-denied, and the job prints `no output produced — a tool required the "command" permission…`.
- **`--sandbox` and `--mode plan` do not stop file writes** once permissions are skipped. Isolation comes from worktrees, not flags.
- **Print mode has no timeout by default.** Background tasks inside a headless run are capped at 30 minutes.
- **The interactive shell wraps `agy`** in a function that switches the kitty theme and prints escape codes. For raw calls use `command agy` or `~/.local/bin/agy`. For example: `command agy -p "…" --model gemini-3.8-flash-high --dangerously-skip-permissions --output-format json </dev/null`. The JSON includes `conversation_id` and `usage`.
- **Output formats:** `--output-format json` returns one object at the end. `stream-json` emits NDJSON events: `init` (with the conversation ID), then `step_update` per tool call or response (with per-step `usage`), then `result`.
- **Where things live:** job state is under `~/.local/state/agy-runs/` (or `$AGY_RUNS`). agy's own transcripts are at `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`. You can resume any conversation with `agy --conversation <id>`.
- **agy extensibility:** custom agents live in `.agents/agents/` (use with `--agent`) and skills in `.agents/skills/`. MCP servers are managed with `agy mcp`, and `agy plugin` manages plugins.
