# fleet-band

A read-only status line above the Claude Code prompt, plus three slash commands that answer with no model turn.

```
main · ctx 42% · room 3 unread · results 0 pending · needs-you 2 · held: alpha
```

The line is dim, capped at 100 columns, and drops fields from the right when the terminal is narrower. It refreshes on a 60 s timer and at the end of each turn, never more often. If the snapshot is older than three refresh periods, the line ends with `(stale)`.

## Install

```
/plugin install fleet-band --marketplace wrg32786/aigent-os
```

Answer `y` to add the marketplace, then pick a scope. A stock install shows only the seat and context %. Every other field stays off until its setting is filled in, in `/config` or under `pluginConfigs.fleet-band` in settings.

## Settings

| Setting | Turns on | Example |
|---|---|---|
| `installRoot` | results pending, `/fires` | `C:/example/aigent` |
| `roomRoot` | room unread; held (with `watchedSeats`) | `C:/example/agent-room/room` |
| `eodPath` | needs-you | `C:/example/cockpit/eod/latest.json` |
| `watchedSeats` | held (with `roomRoot`) | `alpha`, `beta` |
| `showSummaries` | each result's summary in `/fires` | `false` (default) |

An empty setting means the field is skipped and its command says "not configured". A configured source that cannot be read shows as `?`.

## What it reads

| Field | Source |
|---|---|
| seat | env `SEAT`, else the session root's folder name. Lowercased, and it must match `[a-z0-9_-]+`, else `seat`. |
| ctx % | `$.session.usage().context.percent`, the engine's own figure, as the status line shows it |
| room unread | count of `*.json` files directly in `<roomRoot>/inbox/<seat>/` |
| results pending | `node <installRoot>/daemons/job-results.mjs pending`, run with `JOB_RESULTS_ROOT=<installRoot>`. The script's existence is checked once per session; when it is missing, nothing is ever spawned. |
| needs-you | length of `needs_you[]` in `<eodPath>` |
| held | the last 50 lines of `<roomRoot>/state/<seat>.supervisor.log` for each watched seat. A seat is held when its newest `[refresh-cycle] HOLD` line has no later `[refresh-cycle] … released` line. |

**Next fire is not shown.** No cheap local source has the next scheduled fire.

**Large logs read as `?`.** `$.fs.read` refuses files over 4 MiB and has no byte-range read. A supervisor log over that size is reported as `?`, with the reason `log-over-read-cap`. A rotated log or a small per-seat hold-state file fixes this.

## Commands

- `/fires`: each pending job result's job and time. Its summary is shown only with `showSummaries`.
- `/pending`: `/fires` plus the EOD needs-you titles.
- `/held`: each watched seat as `HELD`, `clear` or `?`, with a reason class (`hold-without-release`, `released`, `no-hold-in-tail`, `log-over-read-cap`, `log-unreadable`). Raw log lines and error text are never printed.

Each command refreshes the band and returns `{ text }` with no model turn. The output still enters the session transcript, so the model reads it on its next turn.

## Fences

- No `$.permission` calls and no tool-approval hooks.
- No writes outside `$.state` (`fleet-band.snapshot`).
- No network access.
- No process other than the job-results call above.
- Nothing that submits a prompt.

## Follow-ups

- `/drain`: draining the Room needs the `room_drain` MCP tool and the seat's own judgment, so it is out of scope for a read-only mod.
- A bounded hold-state source, so held can resolve on large logs.

## Develop

```
claude plugin validate <this folder>
claude plugin test <this folder>
claude --plugin-dir <this folder>
```
