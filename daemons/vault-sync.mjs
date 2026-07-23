#!/usr/bin/env node
// vault-sync.mjs — capsule-cycle close persistence for the installed vault.
//
// Rolling Stop capsules stay local and cheap. A capsule-cycle close calls this
// helper after its memory writes land: stage only the installed memory tree,
// create a "vault sync:" commit, push it, and verify the remote received HEAD.
//
// The close lifecycle is never gated on Git. Every failure is returned rather
// than thrown; the CLI is silent and always exits 0. A missing remote is an
// intentional no-op. Git/network failures append one sanitized line to the
// existing daemon error log.

import {
  lstatSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logErr } from './lifecycle-common.mjs';

const GIT_TIMEOUT_MS = 10_000;
const MEMORY_CANDIDATES = ['vault/memory', 'memory'];
const GIT_WRITE_TREES = ['.git/objects', '.git/refs', '.git/logs'];

function oneLine(value) {
  return String(value || '')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1***@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600);
}

function gitEnv() {
  const env = { ...process.env };
  // Hook-provided Git variables can redirect the worktree, index, object store,
  // trace output, config, executables, or auth UI outside the installed root.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith('GIT_')
      || upper === 'SSH_ASKPASS'
      || upper === 'SSH_ASKPASS_REQUIRE'
      || upper === 'GCM_INTERACTIVE'
    ) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.SSH_ASKPASS_REQUIRE = 'never';
  // OpenSSH can bypass stdio and ask on its controlling terminal. BatchMode
  // disables password, passphrase, and host-key confirmation prompts.
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

function git(cwd, args) {
  // safeGitDirectory requires .git/config to be a local regular file before
  // any Git command reaches this helper. A regular file cannot contain a hook
  // child, so using it as hooksPath disables hooks even for read commands that
  // refresh the index (for example `git status`).
  const hookSink = path.join(cwd, '.git', 'config');
  const run = spawnSync('git', [
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${hookSink}`,
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    code: run.error ? 1 : (run.status ?? 1),
    out: String(run.stdout || '').trim(),
    err: oneLine(run.stderr || run.error?.message || ''),
  };
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function containedPath(root, destination) {
  const absolute = path.resolve(String(destination));
  const relative = path.relative(root, absolute);
  const inside = relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (!inside) {
    throw new Error(`refusing path outside installed vault root: ${absolute}`);
  }
  return absolute;
}

// PR #15's installer rule, ported without weakening: after explicit
// containment, walk every component from the canonical install root through
// the destination (inclusive) and refuse an existing symlink.
function requireSymlinkSafe(root, destination) {
  const absolute = containedPath(root, destination);
  const relative = path.relative(root, absolute);
  let walked = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    walked = path.join(walked, part);
    let stat;
    try {
      stat = lstatSync(walked);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || isMsysSymlink(walked, stat)) {
      throw new Error(`refusing to write through symlink: ${walked}`);
    }
  }
  return absolute;
}

// Git Bash can represent a symlink as an MSYS system file when native Windows
// symlink privileges are unavailable. Node sees that form as a regular file;
// its magic header keeps the same boundary test effective on those installs.
function isMsysSymlink(file, stat) {
  if (process.platform !== 'win32' || !stat.isFile() || stat.size < 10 || stat.size > 32_768) {
    return false;
  }
  try {
    const head = readFileSync(file).subarray(0, 20);
    if (head.subarray(0, 10).toString('ascii') === '!<symlink>') return true;
    // `MSYS=winsymlinks` may expose a Windows Shell Link as `name` to Bash
    // while native Node sees the backing `name.lnk`. Recognize the standard
    // Shell Link header + CLSID so that fallback cannot bypass the same guard.
    const shellLinkHeader = '4c0000000114020000000000c000000000000046';
    return file.toLowerCase().endsWith('.lnk') && head.toString('hex') === shellLinkHeader;
  } catch {
    return false;
  }
}

function requireTreeSymlinkSafe(root, directory) {
  const safeDirectory = requireSymlinkSafe(root, directory);
  const stat = lstatSync(safeDirectory);
  if (!stat.isDirectory()) {
    throw new Error(`guarded path is not a directory: ${safeDirectory}`);
  }
  for (const entry of readdirSync(safeDirectory)) {
    const child = requireSymlinkSafe(root, path.join(safeDirectory, entry));
    const childStat = lstatSync(child);
    if (childStat.isDirectory()) requireTreeSymlinkSafe(root, child);
  }
}

/**
 * Resolve the install root from its existing .aigent/state.json marker.
 * The start path is canonicalized first, matching install.sh's canonical TARGET
 * precondition before the PR #15 component walk.
 */
export function installedRootFrom(start) {
  let current;
  try {
    current = realpathSync(String(start || process.cwd()));
    if (!statSync(current).isDirectory()) current = path.dirname(current);
  } catch (error) {
    return { ok: false, root: null, detail: `install root unavailable: ${oneLine(error?.message || error)}` };
  }

  while (true) {
    const markerDirectory = path.join(current, '.aigent');
    let directoryStat = null;
    try { directoryStat = lstatSync(markerDirectory); } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, root: null, detail: `install marker unreadable: ${oneLine(error?.message || error)}` };
      }
    }
    if (directoryStat) {
      if (directoryStat.isSymbolicLink() || isMsysSymlink(markerDirectory, directoryStat)) {
        return { ok: false, root: null, detail: `refusing to read install marker through symlink: ${markerDirectory}` };
      }
      if (directoryStat.isDirectory()) {
        const marker = path.join(markerDirectory, 'state.json');
        let markerStat = null;
        try { markerStat = lstatSync(marker); } catch (error) {
          if (error?.code !== 'ENOENT') {
            return { ok: false, root: null, detail: `install marker unreadable: ${oneLine(error?.message || error)}` };
          }
        }
        if (markerStat) {
          if (markerStat.isSymbolicLink() || isMsysSymlink(marker, markerStat)) {
            return { ok: false, root: null, detail: `refusing to read install marker through symlink: ${marker}` };
          }
          if (!markerStat.isFile()) {
            return { ok: false, root: null, detail: `install marker is not a file: ${marker}` };
          }
          try {
            const state = JSON.parse(readFileSync(marker, 'utf8'));
            if (!Number.isInteger(state?.schemaVersion)) throw new Error('schemaVersion is missing');
          } catch (error) {
            return { ok: false, root: null, detail: `invalid install marker: ${oneLine(error?.message || error)}` };
          }
          return { ok: true, root: current, detail: 'installed root found' };
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { ok: false, root: null, detail: 'no .aigent/state.json install marker found' };
}

function memoryScopes(root) {
  const scopes = [];
  for (const relative of MEMORY_CANDIDATES) {
    const absolute = requireSymlinkSafe(root, path.join(root, ...relative.split('/')));
    let stat;
    try { stat = lstatSync(absolute); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || isMsysSymlink(absolute, stat)) {
      throw new Error(`refusing to write through symlink: ${absolute}`);
    }
    scopes.push({ absolute, relative });
  }
  return scopes;
}

function configuredRemotes(root) {
  const dotGit = path.join(root, '.git');
  let dotGitStat;
  try { dotGitStat = lstatSync(dotGit); } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, exists: false, remotes: [], detail: 'not a git repository' };
    }
    return { ok: false, exists: false, remotes: [], detail: oneLine(error?.message || error) };
  }
  if (dotGitStat.isSymbolicLink() || isMsysSymlink(dotGit, dotGitStat) || !dotGitStat.isDirectory()) {
    return {
      ok: false,
      exists: true,
      remotes: [],
      detail: `refusing redirected git control path: ${dotGit}`,
    };
  }
  try {
    const configFile = requireSymlinkSafe(root, path.join(dotGit, 'config'));
    if (!lstatSync(configFile).isFile()) {
      return {
        ok: false,
        exists: true,
        remotes: [],
        detail: `git config is not a regular file: ${configFile}`,
      };
    }
    const commonMarker = path.join(dotGit, 'commondir');
    try {
      lstatSync(commonMarker);
      return {
        ok: false,
        exists: true,
        remotes: [],
        detail: `refusing redirected git common directory: ${commonMarker}`,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    return { ok: false, exists: true, remotes: [], detail: oneLine(error?.message || error) };
  }

  const listed = git(root, ['remote']);
  if (listed.code !== 0) {
    return {
      ok: false,
      exists: true,
      remotes: [],
      detail: `git remote failed: ${listed.err}`,
    };
  }
  return {
    ok: true,
    exists: true,
    remotes: listed.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    detail: '',
  };
}

function safeGitDirectory(root) {
  const dotGit = path.join(root, '.git');
  let stat;
  try { stat = lstatSync(dotGit); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, detail: 'not a git repository' };
    return { ok: false, exists: false, detail: oneLine(error?.message || error) };
  }
  if (stat.isSymbolicLink() || isMsysSymlink(dotGit, stat) || !stat.isDirectory()) {
    return { ok: false, exists: true, detail: `refusing redirected git control path: ${dotGit}` };
  }
  try {
    for (const relative of [
      '.git',
      '.git/HEAD',
      '.git/COMMIT_EDITMSG',
      '.git/config',
      '.git/index',
      '.git/packed-refs',
    ]) {
      requireSymlinkSafe(root, path.join(root, ...relative.split('/')));
    }
    const configFile = path.join(dotGit, 'config');
    if (!lstatSync(configFile).isFile()) {
      return { ok: false, exists: true, detail: `git config is not a regular file: ${configFile}` };
    }
    const commonMarker = path.join(dotGit, 'commondir');
    try {
      lstatSync(commonMarker);
      return { ok: false, exists: true, detail: `refusing redirected git common directory: ${commonMarker}` };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const absoluteGit = git(root, ['rev-parse', '--absolute-git-dir']);
    const commonGit = git(root, ['rev-parse', '--git-common-dir']);
    if (absoluteGit.code !== 0 || commonGit.code !== 0) {
      return {
        ok: false,
        exists: true,
        detail: `git directory resolution failed: ${absoluteGit.err || commonGit.err}`,
      };
    }
    const canonicalDotGit = realpathSync(dotGit);
    const canonicalAbsolute = realpathSync(
      path.isAbsolute(absoluteGit.out) ? absoluteGit.out : path.resolve(root, absoluteGit.out),
    );
    const canonicalCommon = realpathSync(
      path.isAbsolute(commonGit.out) ? commonGit.out : path.resolve(root, commonGit.out),
    );
    if (!samePath(canonicalAbsolute, canonicalDotGit) || !samePath(canonicalCommon, canonicalDotGit)) {
      return {
        ok: false,
        exists: true,
        detail: `refusing git metadata outside installed vault root: ${canonicalAbsolute} / ${canonicalCommon}`,
      };
    }

    const alternates = path.join(dotGit, 'objects', 'info', 'alternates');
    try {
      lstatSync(alternates);
      return { ok: false, exists: true, detail: `refusing alternate git object directory: ${alternates}` };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const relative of GIT_WRITE_TREES) {
      const guarded = requireSymlinkSafe(root, path.join(root, ...relative.split('/')));
      try {
        if (lstatSync(guarded).isDirectory()) requireTreeSymlinkSafe(root, guarded);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    return { ok: false, exists: true, detail: oneLine(error?.message || error) };
  }
  return { ok: true, exists: true, detail: 'git control path is local' };
}

function configValue(root, key) {
  const value = git(root, ['config', '--get', key]);
  return value.code === 0 ? value.out : '';
}

function selectRemote(root, remotes, branch) {
  const configured = [
    [`branch.${branch}.pushRemote`, configValue(root, `branch.${branch}.pushRemote`)],
    ['remote.pushDefault', configValue(root, 'remote.pushDefault')],
    [`branch.${branch}.remote`, configValue(root, `branch.${branch}.remote`)],
  ];
  let remote = '';
  for (const [key, value] of configured) {
    if (!value) continue;
    if (value === '.' || !remotes.includes(value)) {
      return { error: `${key} selects unavailable push remote ${value}` };
    }
    remote = value;
    break;
  }
  if (!remote && remotes.includes('origin')) remote = 'origin';
  if (!remote && remotes.length === 1) [remote] = remotes;
  if (!remote) return { error: 'multiple remotes configured but no push remote is selected' };

  const branchRemote = configValue(root, `branch.${branch}.remote`);
  const mergeRef = branchRemote === remote ? configValue(root, `branch.${branch}.merge`) : '';
  const remoteBranch = mergeRef.startsWith('refs/heads/')
    ? mergeRef.slice('refs/heads/'.length)
    : branch;
  const pushUrl = git(root, ['remote', 'get-url', '--push', '--all', '--', remote]);
  if (pushUrl.code !== 0 || !pushUrl.out) {
    return { error: `push URL unavailable for remote ${remote}: ${pushUrl.err}` };
  }
  return {
    remote,
    remoteBranch,
    pushUrls: pushUrl.out.split(/\r?\n/).filter(Boolean),
    hasUpstream: branchRemote === remote && mergeRef.startsWith('refs/heads/'),
  };
}

function remoteHead(root, remote, remoteBranch) {
  const reference = `refs/heads/${remoteBranch}`;
  const found = git(root, ['ls-remote', '--heads', '--', remote, reference]);
  if (found.code !== 0) return { ok: false, sha: '', detail: found.err || found.out };
  const line = found.out.split(/\r?\n/).find(Boolean) || '';
  return { ok: true, sha: line.split(/\s+/)[0] || '', detail: '' };
}

function cleanResult(detail) {
  return {
    ok: true, committed: false, pushed: false, detail,
  };
}

/**
 * Commit and push capsule/memory changes without ever throwing into lifecycle.
 *
 * @returns {{ok:boolean, committed:boolean, pushed:boolean, detail:string}}
 */
export function syncInstalledVault(start, { reason = 'capsule-cycle close' } = {}) {
  const result = {
    ok: false, committed: false, pushed: false, detail: '',
  };
  let root = null;
  let logIsSafe = false;
  const fail = (detail, { log = logIsSafe } = {}) => {
    result.detail = oneLine(detail);
    if (log && root) logErr(root, 'vault-sync', result.detail);
    return result;
  };

  try {
    const installed = installedRootFrom(start);
    if (!installed.ok) return fail(installed.detail, { log: false });
    root = installed.root;

    // Probe only the local config before touching memory. With no configured
    // remote the entire operation is a silent no-op, even when local memory
    // contains a path that would be refused in sync-enabled mode.
    const remoteProbe = configuredRemotes(root);
    if (!remoteProbe.ok) return fail(remoteProbe.detail, { log: false });
    if (!remoteProbe.exists) return cleanResult('no git repository');
    if (remoteProbe.remotes.length === 0) return cleanResult('no remote configured');
    const remotes = remoteProbe.remotes;

    const scopes = memoryScopes(root);
    if (scopes.length === 0) return cleanResult('no memory directory');
    for (const scope of scopes) {
      requireSymlinkSafe(root, path.join(scope.absolute, '.daemon-errors.log'));
      // lifecycle-common.logErr writes to the first existing memory candidate;
      // after that exact log path is proven local, later boundary refusals can
      // be recorded without following the refused descendant.
      if (!logIsSafe) logIsSafe = true;
      requireTreeSymlinkSafe(root, scope.absolute);
    }

    const gitDirectory = safeGitDirectory(root);
    if (!gitDirectory.ok) return fail(gitDirectory.detail);
    if (!gitDirectory.exists) return cleanResult('no git repository');

    const top = git(root, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) return fail(`git top-level failed: ${top.err}`);
    let canonicalTop;
    try { canonicalTop = realpathSync(top.out); } catch {
      return fail(`git top-level is not resolvable: ${top.out}`);
    }
    if (!samePath(canonicalTop, root)) {
      return fail(`refusing git repository outside installed vault root: ${canonicalTop}`);
    }

    const branchResult = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branchResult.code !== 0 || !branchResult.out) return fail('detached HEAD; vault sync refused');
    const selected = selectRemote(root, remotes, branchResult.out);
    if (selected.error) return fail(selected.error);
    // Never commit local daemon/runtime state, even on installations whose
    // pre-existing .gitignore lacks the current managed rules.
    const pathspecFor = (scope) => [
      scope.relative,
      `:(exclude,glob)${scope.relative}/.daemon-errors.log*`,
      `:(exclude,glob)${scope.relative}/runtime/stop-writer/**`,
      `:(exclude,glob)${scope.relative}/runtime/utterance-journal*.jsonl`,
    ];
    const changedScopes = [];
    for (const scope of scopes) {
      const scopedPathspec = pathspecFor(scope);
      const status = git(root, [
        'status', '--porcelain', '--untracked-files=all', '--', ...scopedPathspec,
      ]);
      if (status.code !== 0) return fail(`git status failed: ${status.err}`);
      if (status.out) changedScopes.push(scope);
    }

    if (changedScopes.length > 0) {
      // An existing-but-empty memory directory is not a Git pathspec match and
      // would make a multi-scope commit fail atomically. Commit only scopes
      // whose filtered status actually carries a durable change.
      const pathspec = changedScopes.flatMap(pathspecFor);
      const added = git(root, [
        'add', '-A', '--', ...pathspec,
      ]);
      if (added.code !== 0) return fail(`git add failed: ${added.err || added.out}`);

      const staged = git(root, ['diff', '--cached', '--quiet', '--', ...pathspec]);
      if (staged.code === 1) {
        const message = `vault sync: ${reason} (${new Date().toISOString()})`;
        // Explicit pathspec = --only semantics: ambient staged project/code
        // changes remain staged but cannot enter this memory commit.
        const committed = git(root, [
          '-c', 'commit.gpgSign=false',
          'commit', '--only', '--no-verify', '-m', message, '--', ...pathspec,
        ]);
        if (committed.code !== 0) return fail(`git commit failed: ${committed.err || committed.out}`);
        result.committed = true;
      } else if (staged.code !== 0) {
        return fail(`git diff failed: ${staged.err || staged.out}`);
      }
    }

    const local = git(root, ['rev-parse', 'HEAD']);
    if (local.code !== 0) return fail(`git HEAD failed: ${local.err}`);
    if (selected.hasUpstream && !result.committed) {
      const ahead = git(root, ['rev-list', '--count', `@{u}..${local.out}`]);
      if (ahead.code === 0 && Number(ahead.out) === 0) {
        result.ok = true;
        result.pushed = true;
        result.detail = 'clean; already in sync';
        return result;
      }
    }

    const pushed = git(root, [
      'push', '--no-verify', '--', selected.remote,
      `${local.out}:refs/heads/${selected.remoteBranch}`,
    ]);
    if (pushed.code !== 0) return fail(`git push failed: ${pushed.err || pushed.out}`);

    let verified = false;
    let verifyDetail = '';
    if (selected.hasUpstream) {
      const after = git(root, ['rev-list', '--count', `@{u}..${local.out}`]);
      verified = after.code === 0 && Number(after.out) === 0;
      verifyDetail = after.err || `${after.out || '?'} commit(s) still ahead`;
    } else {
      const checks = selected.pushUrls.map(
        (pushUrl) => remoteHead(root, pushUrl, selected.remoteBranch),
      );
      verified = checks.every((check) => check.ok && check.sha === local.out);
      verifyDetail = checks
        .filter((check) => !check.ok || check.sha !== local.out)
        .map((check) => check.detail || `${check.sha || 'no remote SHA'} != ${local.out}`)
        .join('; ');
    }
    if (verified) {
      result.ok = true;
      result.pushed = true;
      result.detail = 'committed + pushed + verified';
      return result;
    }
    return fail(`push reported success but verification failed: ${verifyDetail}`);
  } catch (error) {
    return fail(`vault sync refused: ${oneLine(error?.message || error)}`);
  }
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  const reasonIndex = process.argv.indexOf('--reason');
  const reason = reasonIndex >= 0 && process.argv[reasonIndex + 1]
    ? process.argv[reasonIndex + 1]
    : 'capsule-cycle close';
  const start = process.env.AIGENT_ROOT
    || process.env.CLAUDE_PROJECT_DIR
    || process.cwd();
  syncInstalledVault(start, { reason });
  process.exitCode = 0;
}
