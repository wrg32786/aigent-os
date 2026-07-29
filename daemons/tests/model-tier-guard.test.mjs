// model-tier-guard.test.mjs -- routing-enforcement regression guard.
//
// Proves the contract of daemons/model-tier-guard.mjs:
//   - a dispatch matching its declared model: passes silently, exit 0
//   - a dispatch to one of our named agents with the WRONG (or no) model
//     prints a named [MODEL-TIER] correction, DEFAULT exit 0 (advisory --
//     never blocks unless the operator opted in)
//   - AIGENT_MODEL_GUARD=enforce turns that same mismatch into
//     decision:block + exit 2
//   - a subagent_type that doesn't match any installed agent definition (a
//     fork's own custom agent, or a Claude Code built-in like
//     general-purpose) passes through silently -- never enforces a promise
//     aigent-OS didn't make
//   - resolves .claude/agents/ (runtime/installed) first, vault/agents/
//     (source-tree dogfood) as fallback
//
// Run: node daemons/tests/model-tier-guard.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(DAEMONS, 'model-tier-guard.mjs');
const TMP = path.join(os.tmpdir(), `mtg-test-${process.pid}`);

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };

function agentDoc(name, model) {
  return `---\nname: ${name}\ndescription: test fixture\ntools:\n  - Read\nmodel: ${model}\n---\n\n# ${name}\n`;
}

const run = (input, root, env = {}) => spawnSync(process.execPath, [GUARD], {
  encoding: 'utf8', timeout: 5000, windowsHide: true, input,
  env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: '', AIGENT_MODEL_GUARD: '', ...env },
});

const dispatch = (subagent_type, model) => JSON.stringify({
  tool_name: 'Agent',
  tool_input: { subagent_type, ...(model !== undefined ? { model } : {}), description: 'test dispatch' },
});

rmSync(TMP, { recursive: true, force: true });

// ── syntax ────────────────────────────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, ['--check', GUARD], { encoding: 'utf8' });
  check('syntax model-tier-guard.mjs', r.status === 0, r.stderr?.trim().split('\n')[0] ?? '');
}

// ── runtime layout: .claude/agents/ ──────────────────────────────────────────
const RUNTIME = path.join(TMP, 'runtime-install');
mkdirSync(path.join(RUNTIME, '.claude', 'agents'), { recursive: true });
writeFileSync(path.join(RUNTIME, '.claude', 'agents', 'Lyra.md'), agentDoc('Lyra', 'sonnet'));

{
  const r = run(dispatch('Lyra', 'sonnet'), RUNTIME);
  check('matched tier: silent pass, exit 0', r.status === 0 && (r.stdout || '').trim() === '', `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = run(dispatch('lyra', 'SONNET'), RUNTIME);
  check('matched tier is case-insensitive on both name and model', r.status === 0 && (r.stdout || '').trim() === '');
}
{
  const r = run(dispatch('Lyra', 'opus'), RUNTIME);
  check('wrong model: DEFAULT advisory, exit 0', r.status === 0, `status=${r.status}`);
  check('wrong model: names quoted agent, tier, and request data',
    /\[MODEL-TIER\] agent "Lyra" is defined to run on model "sonnet"/.test(r.stdout)
      && /this dispatch specified "opus"/.test(r.stdout),
    JSON.stringify(r.stdout));
}
{
  const r = run(dispatch('Lyra'), RUNTIME); // model omitted entirely
  check('missing model: flagged as silently-inherited, exit 0', r.status === 0 && /\(none -- silently inherits the caller's model\)/.test(r.stdout), JSON.stringify(r.stdout));
}
{
  const r = run(dispatch('Lyra', 'opus'), RUNTIME, { AIGENT_MODEL_GUARD: 'enforce' });
  check('enforce mode: wrong model becomes decision:block + exit 2', r.status === 2 && /"decision":"block"/.test(r.stdout), `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = run(dispatch('Lyra', 'sonnet'), RUNTIME, { AIGENT_MODEL_GUARD: 'enforce' });
  check('enforce mode: matched tier still passes silently', r.status === 0 && (r.stdout || '').trim() === '');
}

// ── unknown agent -- never enforces a promise aigent-OS didn't make ─────────
{
  const r = run(dispatch('general-purpose', undefined), RUNTIME);
  check('unmatched subagent_type (Claude Code built-in): silent pass-through', r.status === 0 && (r.stdout || '').trim() === '', JSON.stringify(r.stdout));
}
{
  const r = run(dispatch('general-purpose', undefined), RUNTIME, { AIGENT_MODEL_GUARD: 'enforce' });
  check('unmatched subagent_type: still silent even in enforce mode', r.status === 0 && (r.stdout || '').trim() === '');
}

// ── source-tree dogfood fallback: vault/agents/ when .claude/agents/ absent ──
const SOURCE = path.join(TMP, 'source-tree');
mkdirSync(path.join(SOURCE, 'vault', 'agents'), { recursive: true });
writeFileSync(path.join(SOURCE, 'vault', 'agents', 'Newton.md'), agentDoc('Newton', 'haiku'));
{
  const r = run(dispatch('Newton', 'opus'), SOURCE);
  check('vault/agents/ fallback resolves when .claude/agents/ is absent',
    r.status === 0 && /agent "Newton" is defined to run on model "haiku"/.test(r.stdout),
    JSON.stringify(r.stdout));
}

// ── no agent-def directory at all -- never throws, never blocks ─────────────
{
  const BARE = path.join(TMP, 'bare');
  mkdirSync(BARE, { recursive: true });
  const r = run(dispatch('Lyra', 'opus'), BARE);
  check('no agent-def directory: exit 0, no output', r.status === 0 && (r.stdout || '').trim() === '');
}

// ── malformed stdin never crashes the hook ───────────────────────────────────
{
  const r = run('not json at all', RUNTIME);
  check('malformed stdin: exit 0, never throws', r.status === 0);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `MODEL-TIER-GUARD.TEST: FAIL (${failed})` : 'MODEL-TIER-GUARD.TEST: PASS');
process.exit(failed ? 1 : 0);
