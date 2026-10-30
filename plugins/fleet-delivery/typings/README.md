# Engine typings, vendored

`claude-code.d.ts` is the Claude Code plugin API declaration file (Written by Claude Code 2.1.312.), copied from the file the engine writes beside a loaded mod (`<mod>/.claude-plugin/types/claude-code/index.d.ts`, or the plugin-authoring skill's `types/claude-code.d.ts`). It is here so `tsc -p plugins/fleet-delivery` type-checks the hooks module and its test against the real engine contract in CI, where no engine has loaded the mod.

Refresh it after a Claude Code update: copy the new file over this one and commit; the first line names the version that wrote it. Nothing imports it at run time.
