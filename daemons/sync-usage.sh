#!/bin/bash
# sync-usage.sh — local session usage logger for aigent-OS.
#
# Appends the most recent Claude Code session's token usage to memory/usage_log.md
# so /open and /close have a local signal for context/cost awareness.
#
# Fully self-contained: NO network calls, NO API keys, NO external services.
# Designed to NEVER fail its caller — exits 0 on any error so /close is never blocked.

VAULT="${AIGENT_VAULT:-${AIGENT_ROOT:-$(pwd)}}"
LOG="$VAULT/memory/usage_log.md"

PROJECTS_DIR="$HOME/.claude/projects"
[ -d "$PROJECTS_DIR" ] || exit 0

# Best-effort: most recent transcript across this machine's Claude Code projects.
LATEST=$(ls -t "$PROJECTS_DIR"/*/*.jsonl 2>/dev/null | head -1)
[ -z "$LATEST" ] && exit 0

if command -v node >/dev/null 2>&1; then
  node -e '
    const fs=require("fs"), path=require("path");
    try{
      const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
      let inTok=0,outTok=0;
      for(const l of lines){
        try{
          const j=JSON.parse(l), u=j&&j.message&&j.message.usage;
          if(u){
            inTok+=(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);
            outTok+=(u.output_tokens||0);
          }
        }catch(e){}
      }
      const sid=path.basename(process.argv[1],".jsonl");
      const line="- "+new Date().toISOString()+" | session "+sid+" | in "+inTok+" | out "+outTok+"\n";
      fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});
      if(!fs.existsSync(process.argv[2])) fs.writeFileSync(process.argv[2],"# Usage Log\n\nLocal token-usage history (one line per /close). No data leaves this machine.\n\n");
      fs.appendFileSync(process.argv[2],line);
    }catch(e){}
  ' "$LATEST" "$LOG" 2>/dev/null
fi

exit 0
