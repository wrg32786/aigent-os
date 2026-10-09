# Mods

A mod is a Claude Code plugin made of function hooks: a `.claude-plugin/plugin.json` manifest, a `hooks/hooks.json` that names one hooks module, and that module (`hooks/register.tsx`), which hooks engine events such as `ui.render`, `session.start` and `command.run` and reaches everything outside itself through `$`. Mods in this folder follow these fences: no `$.permission` or tool-approval calls; no writes outside the mod's own `$.state`; no network; no host process beyond the one the mod's README names; and nothing that submits a prompt. Before a change ships, run `claude plugin validate plugins/<mod>` (it should pass with no errors) and `claude plugin test plugins/<mod>` (it should be green), then `tsc -p plugins/<mod>` once the engine has laid its types beside the mod. Install a mod from a terminal session with `/plugin install <mod> --marketplace wrg32786/aigent-os`. During development, load the folder directly with `claude --plugin-dir plugins/<mod>`.

## Operating facts

- A folder marketplace (`claude plugin marketplace add <folder>`) is read live, and edits load on `/reload-plugins`. The folder you add must stay on the code you want running: switching its branch or checkout changes what loads.
- The same plugin name loaded from two folders produces "1 error during load". Keep one copy.
- `claude plugin install --config key=v` repeated for a list field keeps only the last value. Set list fields directly under `pluginConfigs` in `settings.json`, for example `"pluginConfigs": { "alpha": { "beta": ["one", "two"] } }`.
