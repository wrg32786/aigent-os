# The AIgent: Launcher (the branded front door)

Not every operator wants to remember `cd` into a folder and type `claude` every session.
This launcher is an optional convenience layer: it wraps the harness in a branded front
door so starting a session feels like opening an app, not learning a terminal workflow.

Double-click an "AIgent" icon (or type `aigent` in any shell) and your AIgent wakes up,
warm-resumed, in a branded window. No `cd`, no flags, no commands to memorize — though
nothing stops you from just running `claude` directly if you'd rather skip the launcher
entirely.

## Files
| File | Role |
|---|---|
| `aigent.ps1` | Windows core launcher: branded banner, finds the harness, first-run vs warm-resume. |
| `aigent.cmd` | Windows double-click / PATH entry (thin wrapper over `aigent.ps1`). |
| `aigent.sh` | macOS / Linux launcher (same behavior). |
| `install.ps1` | Windows: PATH shim + Desktop/Start "AIgent" shortcuts + `AIGENT_HOME`. |
| `install.sh` | macOS / Linux: symlinks `aigent` into `~/.local/bin` + records `AIGENT_HOME`. |
| `aigent.ico` | (optional) 256px brand icon for the Windows shortcut — drop your own here. |

## Behavior
- **First launch** runs `/start`: the guided first-run flow (install check ->
  `/operator-setup` interview -> one real win) and writes `.aigent/first-run-done`.
- **Every launch after** runs `claude --continue`: the operator never cold-starts.
- `AIGENT_HOME` points at the installed harness (installer sets it; falls back to `~/aigent`).

## Dependencies
- The harness ships two skills this launcher depends on: **`/start`** (first-run
  experience + action menu) and **`/operator-setup`** (the operator interview).
- `aigent.ico` is a 256px brand icon for the Windows shortcut — drop your own here if
  you want a custom icon; the installer falls back to a generic icon if it's absent.
- This is a single-principal launcher: no supervisor process or multi-agent comms mesh.
  It is a deliberately simple pattern — wrapped-session + `--continue` warm-resume +
  a desktop shortcut — designed for one operator running their own install.
