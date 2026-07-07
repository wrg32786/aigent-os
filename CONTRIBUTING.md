# Contributing to aigent-OS

Thanks for considering a contribution. aigent-OS is opinionated infrastructure for principals who want their AI to operate, not just answer. Contributions that match that ethos are welcome.

## What lands well

The highest-value contributions, ranked by leverage:

1. **Decision framework lenses for new domains.** `system/04_decision_frameworks.md` ships 12 lenses. Domain-specific additions (legal, clinical, marketing, manufacturing) are valuable.
2. **Hook scripts for additional Claude Code events.** Anything in `hooks/` that runs silently in the background and earns its keep on the next session.
3. **Vault templates.** Engineering, legal, consulting, creative — populated `vault/templates/*.md` files that fork-friendly users can drop in.
4. **Integration guides.** Notion, Linear, Slack, n8n, Make. How to wire aigent-OS into the rest of someone's stack.
5. **Examples.** Sanitized, populated `vault/examples/*.md` files showing what good content looks like in practice.

## What probably doesn't land

- New base system docs in `system/00–14`. Those are the kernel — changes go through deeper review.
- Personality prompts. aigent-OS is operational, not conversational. "You are a helpful assistant"-style prompts get rejected.
- Heavy dependencies. Zero-build, zero-server is a hard constraint. Anything requiring a database, a backend, or a Python virtualenv beyond what's already there is a tougher sell.

## How to contribute

1. **Open an issue first** for anything beyond a typo fix or doc improvement. We'll align on scope before you spend time.
2. **Fork, branch, PR.** Standard flow. Branch names: `feat/short-description` or `fix/short-description`.
3. **Match the existing style.**
   - Markdown files have YAML frontmatter where existing ones do.
   - Wikilinks (`[[Note Name]]`) for cross-references inside `vault/`.
   - Bullets over paragraphs. Concrete over abstract.
4. **Add to CHANGELOG.md** under `[Unreleased]`.
5. **Don't include personal context.** No real names, businesses, or operational details. If you fork from your daily-use vault, scrub before opening the PR.

## How rules get written (META)

Rules in `CLAUDE.md`, `system/`, and `vault/concepts/` follow the META section in `CLAUDE.md`:

- Use absolute directives (NEVER / ALWAYS)
- Lead with why
- Be concrete
- Minimize examples
- Bullets over paragraphs

If a new rule duplicates an existing one, update the existing — don't add another.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
