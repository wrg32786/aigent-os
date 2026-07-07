# Security Policy

aigent-OS processes operational context — priorities, decisions, business details, sometimes credentials referenced by hooks. Vulnerabilities here can leak the principal's working memory or enable unauthorized actions through the authority matrix. Treat this seriously.

## Reporting a Vulnerability

**Do not post security vulnerabilities publicly.**

Report security issues through [GitHub Security Advisories](https://github.com/wrg32786/aigent-os/security/advisories/new) for this repository, or open a private report to the maintainer if you don't have a GitHub account. Include:

- A description of the vulnerability and its impact
- Reproduction steps (or a proof-of-concept)
- The version of aigent-OS you tested against
- Any suggested mitigation

The maintainer will acknowledge and respond through that channel.

## Response Targets

| Stage | Target |
|---|---|
| Acknowledgment | Within 3 business days |
| Triage + severity assessment | Within 7 business days |
| Fix or mitigation in main | Within 30 days for High/Critical, 90 days for Medium/Low |
| Public disclosure | Coordinated — typically within 14 days of fix landing |

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
- Bypassing the prompt-injection defender (if installed)
- Unbounded resource use that locks up a session

### 3. Skills and daemons (`skills/`, `daemons/`)
Skills and daemons can read/write the vault and invoke external tools. Vulnerabilities include:
- Skills that exfiltrate vault content to external endpoints without consent
- Daemons that run unbounded background processes
- Skills that sidestep the [authority matrix](system/12_authority_matrix.md)
- Skills that run unsigned code from external URLs

## What Does NOT Count

- "The AI did something dumb" — not a security issue, that's a prompt or doctrine problem. Open a regular issue.
- Prompt injection that the prompt-injection defender catches — working as designed.
- The fact that vault files are stored as plaintext markdown — by design (the [legibility thesis](docs/manifesto.md)). Encrypt at the disk layer if your threat model requires it.
- Authority matrix enforcement gaps in user-customized rules — your matrix, your rules. The shipped defaults are the security boundary.

## Built-in Defense Layers

aigent-OS ships with three defensive layers:

1. **Authority Matrix** ([`system/12_authority_matrix.md`](system/12_authority_matrix.md)) — defines what the AI can do autonomously, what needs approval, what it must never touch. The deepest protection: even if other layers fail, an AI that respects the matrix can't authorize itself to spend money or send messages.

2. **Prompt-Injection Defender** (`hooks/security-scan.sh`) — PostToolUse scan over `Read`, `WebFetch`, `Bash`, `Grep` outputs. Catches common injection patterns. See [`docs/security.md`](docs/security.md) for setup.

3. **Per-file privacy flag** (`private: true|false|review` in YAML frontmatter) — defense-in-depth for the publish path. Files marked `private: true` can never be sanitized into the public repo by the publish skill, regardless of content review.

## Disclosure Hall of Fame

Once a vulnerability has been fixed and disclosed, the reporter is added (with permission) to a hall of fame in [`CHANGELOG.md`](CHANGELOG.md).

## Cryptographic Signing

Tagged releases are not cryptographically signed yet. This is on the roadmap for v0.3 (sigstore or GPG). Until then: install via the pinned commit SHA when in doubt — see [`docs/install-security.md`](docs/install-security.md).
