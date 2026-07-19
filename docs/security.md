# Security

aigent-OS processes your operational context — priorities, decisions, business details. Security matters.

## Built-In Protections

### Authority Matrix as Security Boundary

The authority matrix (`system/12_authority_matrix.md`) is the primary security control. It defines what the AI can do autonomously, what needs approval, and what it should never touch. This prevents:

- **Unauthorized actions** — AI can't spend money, send emails, or make irreversible decisions without explicit approval
- **Scope creep** — Clear boundaries prevent the AI from acting outside its defined role
- **Escalation failures** — Uncertain situations get surfaced, not guessed at

### Vault Privacy

The vault contains your operational brain. Protections:

- **Local by default** — Everything runs on your machine. No cloud sync required.
- **Semantic search is local** — The `all-MiniLM-L6-v2` model runs on your device. No data sent to any API.
- **Git awareness** — The `.gitignore` excludes `embeddings.json` and `.obsidian/` config. Sensitive files don't accidentally get committed.

## Recommended: Prompt Injection Defense

When your AI reads external content (web pages, files, API responses), that content could contain instructions designed to manipulate the AI's behavior. This is called **prompt injection**.

### Add a PostToolUse Security Hook

Create a script that scans tool outputs for injection patterns:

```bash
# hooks/security-scan.sh
#!/bin/bash
# Scans tool output for common prompt injection patterns

INPUT=$(cat)
RESPONSE=$(echo "$INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const output = JSON.stringify(d.tool_response || '').toLowerCase();
  const patterns = [
    'ignore all previous',
    'ignore your instructions',
    'you are now',
    'new instructions:',
    'system prompt:',
    'disregard everything',
    'override your',
    'forget your rules',
    'act as if',
    'pretend you are'
  ];
  const found = patterns.filter(p => output.includes(p));
  if (found.length > 0) {
    console.log(JSON.stringify({
      warning: 'Potential prompt injection detected',
      patterns: found,
      tool: d.tool_name
    }));
  }
" 2>/dev/null)

if [ -n "$RESPONSE" ]; then
  echo "[SECURITY] $RESPONSE"
fi
```

Wire it into your Claude Code settings:

```json
{
  "PostToolUse": [
    {
      "matcher": "Read|WebFetch|Bash|Grep|WebSearch",
      "hooks": [
        {
          "type": "command",
          "command": "bash \"__AIGENT_ROOT__/hooks/security-scan.sh\"",
          "timeout": 2000
        }
      ]
    }
  ]
}
```

Replace `__AIGENT_ROOT__` with your absolute install path (the installer does this automatically; hand-wiring, substitute it yourself — see [Advanced Setup](advanced-setup.md#hook-configuration)). A bare `AIGENT_ROOT` resolves to a nonexistent relative path and the hook silently never fires.

### What It Catches

- Instructions embedded in web pages telling the AI to change behavior
- Manipulated file contents trying to override system prompts
- API responses containing injection payloads

### What It Doesn't Catch

- Subtle manipulation that doesn't use known patterns
- Social engineering through plausible-looking content
- Obfuscated or encoded payloads

This is a first line of defense, not a complete solution. The authority matrix is the deeper protection — even if injection succeeds in changing the AI's intent, the authority boundaries prevent unauthorized actions.

## Best Practices

1. **Review before committing.** Always check `git diff` before pushing. Make sure no secrets, API keys, or sensitive vault content leaked into commits.

2. **Use .gitignore.** The default `.gitignore` covers common cases. Add any sensitive file patterns specific to your setup.

3. **Separate vaults for separate contexts.** If you work with multiple organizations, consider separate aigent-OS installations. Don't mix confidential contexts.

4. **Audit the vault periodically.** Check that no sensitive information crept into notes that shouldn't contain it. The vault is markdown files — you can grep for patterns like API keys, passwords, or financial details.

5. **Back up the vault.** It's your AI's brain. Treat it like you'd treat any critical data. Git + a backup service covers most cases.

## API Key Safety

If your hooks or tools use API keys:

- Store them in environment variables, not in vault files
- Use `.env` files excluded from git
- Never hardcode keys in hook scripts that might be committed
- If a key appears in the vault accidentally, rotate it immediately
