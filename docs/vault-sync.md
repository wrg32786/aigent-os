# Vault sync: approve the destination, not the remote name

Capsule creation saves files locally. `daemons/vault-sync.mjs` is the separate,
fail-soft Git publication step. A configured remote, including the public
product's `origin` after cloning, is not permission to publish memory there.

## Default and upgrade behavior

With no remote, sync remains a silent no-op. With a remote but no matching local
approval, the helper refuses before staging, committing or pushing. Local capsule
files remain untouched. The API returns `ok: false`, `committed: false` and
`pushed: false`; a sanitized `vault-sync` record goes to the resolved memory
root's `.daemon-errors.log`. The CLI still exits 0 without output so a backup
problem cannot wedge a capsule acknowledgement or clear. Exit 0 is not sync proof.

This is a deliberate safer default for existing installs too. An upgrade does
not infer approval from prior successful pushes or automatically enroll remotes.
Before deploying to a working seat, its operator must review the destination
and decide whether to enable this optional backup. No remote or credential is
changed by the helper. Do not disable a working backup without its update plan.

## Enable only after reviewing the repository and its audience

In the installed root, inspect the selected remote's effective push destinations:

```sh
git remote get-url --push --all origin
```

Use the actual selected remote when it is not `origin`. Selection still follows
`branch.<name>.pushRemote`, `remote.pushDefault`, the branch remote, then the
existing origin/single-remote fallback. Git resolves `pushurl`, `insteadOf` and
`pushInsteadOf`; approve the resulting exact value, not the fetch URL or alias.

After verifying ownership, visibility, access and suitability for ALL memory
and reachable Git history, the operator records each reviewed destination:

```sh
git config --local --add aigent.vaultSyncPushUrl '<reviewed exact push URL>'
```

Do not pipe the inspection output into this command: inspection is not approval.
A global setting or included config does not enroll an installation. There are
no wildcard approvals. With multiple push URLs, every destination needs approval
or the entire sync is refused before publication to any of them.

Review the values without exposing credentials:

```sh
git config --local --no-includes --get-all aigent.vaultSyncPushUrl
```

Remove local approvals to disable automatic Git publication:

```sh
git config --local --unset-all aigent.vaultSyncPushUrl
```

No-value removal can return nonzero. Revocation does not erase old remote copies,
remove already-local commits or stop a network operation already in progress.
Pause sync while changing Git configuration. The helper rechecks both routing
and approval after local writes and before pushing; it does not lock out another
process rewriting Git configuration concurrently.

## What a successful sync establishes

Only the declared memory tree is staged, with the existing runtime exclusions.
Ambient staged code stays staged. The push uses an explicit commit/refspec, no
forced history rewrite, no automatic tag following and no submodule pushes.
Git still transfers the ancestry reachable from that commit, not just the paths
staged this turn. Use a dedicated private vault repository where appropriate.

The helper verifies HEAD against every approved push URL using `ls-remote`.
A local upstream tracking ref alone is not receipt evidence, especially when the
fetch URL differs from the push URL. An authorized push failure leaves its local
commit in place and records the failure; partial multi-destination success is
not an all-destinations success. Nothing automatically retries in a new daemon.

This guard prevents accidental publication through an unapproved Git remote.
It does not authenticate human consent, determine repository visibility, scan
secrets, sandbox Git, or constrain a malicious owner-controlled config, remote
helper, SSH configuration or server redirect. An actor able to change local
config or run Git directly can bypass it. Never put credentials in approved URLs.

## Checks

```sh
node --test daemons/tests/vault-sync-approval.test.mjs
bash tests/test-vault-sync.sh
```

The tests use synthetic memory and local bare Git repositories only. No real
vault, hosted repository, provider account or business operation is exercised.
