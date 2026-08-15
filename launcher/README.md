# The AIgent: Launcher (the branded front door)

The root `bash install.sh` command wires this front door automatically. Type `aigent` in a new terminal, or open the installed AIgent app/shortcut, and the operator wakes up warm-resumed with managed Auto-Refresh active. No `cd`, flags, or second installer command are required.

The launcher is the supported default because it starts Claude inside `daemons/pty-runner.mjs`. Running `claude` directly remains possible, but it bypasses the managed Auto-Refresh transport.

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
