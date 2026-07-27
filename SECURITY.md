# Security Policy

aigent-OS processes operational context: priorities, decisions, business details, sometimes credentials referenced by hooks. Vulnerabilities here can leak the principal's working memory or drive the agent into actions the principal never approved. Treat this seriously.

## Reporting a Vulnerability

**Do not post security vulnerabilities publicly.**

GitHub's private vulnerability reporting form is **not enabled on this repository yet**, so there is no self-serve private channel. The route that works today is a two-step handshake:

1. Open a regular issue containing **only** the sentence "Security report, requesting a private channel." Include no details, no reproduction, and no hint of the affected component.
2. The maintainer opens a draft security advisory and adds you to it. Everything substantive is exchanged there, privately.

Be aware of what that costs you: step 1 is public, so the *existence* of a report is visible even though its content is not. If [private vulnerability reporting](https://github.com/wrg32786/aigent-os/security/advisories/new) has been enabled by the time you read this, use it directly and skip the handshake entirely.

Either way, include:

- A description of the vulnerability and its impact
- Reproduction steps (or a proof-of-concept)
- The version of aigent-OS you tested against
- Any suggested mitigation

The maintainer will acknowledge and respond in the advisory.

## Response Targets

| Stage | Target |
|---|---|
| Acknowledgment | Within 3 business days |
| Triage + severity assessment | Within 7 business days |
| Fix or mitigation in main | Within 30 days for High/Critical, 90 days for Medium/Low |
| Public disclosure | Coordinated: typically within 14 days of fix landing |

These are targets, not contractual SLAs. This project is maintained by an individual; response cadence reflects that.

## What Counts as a Vulnerability

This is a **markdown-based framework**, not a server-side application. Vulnerabilities tend to live in three places:

### 1. Install path (`install.sh`)
Anything in the install script that:
- Executes attacker-controlled code from a non-pinned source
- Writes outside the user-confirmed install directory
- Modifies the user's existing files without explicit prompting
- Embeds secrets in the installed configuration

See [`docs/install-security.md`](docs/install-security.md) for the trust model and how to do a checksum-pinned install.

### 2. Hooks (`hooks/`)
Hooks run with the user's permissions on every Claude Code event. Vulnerabilities here include:
- Command injection via unescaped tool output
- Logging secrets to files outside the vault
- Suppressing the prompt-injection warning scan so it stops reporting matches it would otherwise print
- Unbounded resource use that locks up a session

### 3. Skills and daemons (`skills/`, `daemons/`)
Skills and daemons can read/write the vault and invoke external tools. Vulnerabilities include:
- Skills that exfiltrate vault content to external endpoints without consent
- Daemons that run unbounded background processes
- Skills written to talk the model out of the [authority matrix](system/12_authority_matrix.md) rather than escalate to the operator
- Skills that run unsigned code from external URLs

## What Does NOT Count

- "The AI did something dumb": not a security issue, that's a prompt or doctrine problem. Open a regular issue.
- Prompt injection that the warning scan already flags: working as designed. A phrasing it misses is a useful issue, but file it as an enhancement, not a vulnerability; the scan is explicitly a partial-coverage alert, not a filter.
- The fact that vault files are stored as plaintext markdown, by design (the [legibility thesis](docs/manifesto.md)). Encrypt at the disk layer if your threat model requires it.
- Authority matrix wording in user-customized rules: your matrix, your rules. Note that the matrix is doctrine and not enforcement (see "Built-in Defense Layers"), so "the model exceeded its stated authority level" is a doctrine bug and belongs in a regular issue, not here.

## Built-in Defense Layers

Two of these are code that runs. The first is doctrine the model is asked to follow. The distinction is stated plainly rather than blurred, because it changes what you can rely on:

1. **Authority Matrix** ([`system/12_authority_matrix.md`](system/12_authority_matrix.md)): a markdown document loaded into the model's context defining what the AI may do autonomously, what needs approval, and what it must never touch. **It is a behavioral boundary, not a technical one.** No hook enforces it and nothing inspects a pending action against it; it works because the model follows its own instructions, and it fails the way instructions fail. Treat it as the policy layer, and use Claude Code's own `permissions` settings plus OS-level controls for anything you need actually enforced.

2. **Prompt-injection warning scan** (`hooks/security-scan.sh`): a PostToolUse hook, wired by the installer with matcher `Read|WebFetch|WebSearch|Bash|Grep`. It matches tool output against a fixed list of common injection phrases and prints a severity-tagged warning line. It only warns: it cannot block a tool call, it catches only phrasings on its list, and it is a signal to the operator rather than a filter. See [`docs/security.md`](docs/security.md).

3. **Credential redaction in activity capture** (`hooks/auto-capture.sh`, which pipes through `hooks/tool-tracker.js`): the hook that records tool activity into the vault stores metadata only, and runs captured values through a redaction pass (private-key blocks, `Bearer` and `Basic` headers, JWTs, `api_key`/`password`-style assignments, common token prefixes, URL userinfo) before anything is written. Defense in depth against a secret landing in a daily note, not a guarantee that every secret format is recognized.

### Not shipped yet

The self-publishing path described in the [manifesto](docs/manifesto.md), a skill that classifies vault files by a `private: true|false|review` frontmatter flag, secret-scans them, and opens the release PR, **is a roadmap item and not a shipped control.** No file in this repo carries that flag today and no code reads it. Do not rely on it to keep anything out of a public release; that decision is currently entirely manual. No plan in this repo schedules the skill itself; the nearest related item is a proposed public-content lint that would keep files marked `private: true` out of release artifacts ([`docs/review-hardening-plan.md`](docs/review-hardening-plan.md)).

## Disclosure Hall of Fame

Once a vulnerability has been fixed and disclosed, the reporter is added (with permission) to a hall of fame in [`CHANGELOG.md`](CHANGELOG.md).

## Cryptographic Signing

Tagged releases are not cryptographically signed yet. This is on the roadmap for v0.3 (sigstore or GPG). Until then: install via the pinned commit SHA when in doubt; see [`docs/install-security.md`](docs/install-security.md).
