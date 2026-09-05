#!/bin/bash
# sync-usage.sh — local session usage logger for aigent-OS.
#
# Appends the most recent Claude Code session's token usage to memory/usage_log.md
# so /open and /close have a local signal for context/cost awareness.
#
# Fully self-contained: NO network calls, NO API keys, NO external services.
# Designed to NEVER fail its caller — exits 0 on any error so /close is never blocked.

VAULT="${AIGENT_VAULT:-${AIGENT_ROOT:-$(pwd)}}"
# Memory root: resolved by daemons/memory-root.cjs, the one resolver every core
# reader and writer shares (declared in .aigent/state.json, default vault/memory).
# A broken declaration is reported on stderr and this best-effort script exits
# without writing anywhere.
SELF_DIR=$(dirname "$0")
SELF_DIR=$(cd "$SELF_DIR" && pwd)
. "$SELF_DIR/memory-root.sh"
MEMORY_ROOT="$(aigent_memory_root "${AIGENT_STATE_HOME_DIR:-$VAULT}" 2>&1)" \
  || { printf '%s\n' "$MEMORY_ROOT" >&2; exit 0; }
LOG="$MEMORY_ROOT/usage_log.md"

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
      const inert=(value,max=120)=>{
        let text=String(value??"")
          .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g," ")
          .replace(/[ \t]+/g," ")
          .trim();
        if(text.length>max) text=text.slice(0,max)+"…[+"+(text.length-max)+" chars]";
        return JSON.stringify(text);
      };
      const line="- "+new Date().toISOString()+" | session "+inert(sid)+" | in "+inTok+" | out "+outTok+"\n";
      fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});
      if(!fs.existsSync(process.argv[2])) fs.writeFileSync(process.argv[2],"# Usage Log\n\nLocal token-usage history (one line per /close). No data leaves this machine.\n\n");
      fs.appendFileSync(process.argv[2],line);
    }catch(e){}
  ' "$LATEST" "$LOG" 2>/dev/null
fi

exit 0
