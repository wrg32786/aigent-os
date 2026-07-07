// Tool activity tracker hook for Claude Code. Invoked via PostToolUse (auto-capture.sh).
// Reads JSON from stdin (not argv) to avoid Windows Defender ClickFix.MTB heuristic:
// node.exe <script> <large-JSON-argv> matches attacker payload pattern; stdin does not.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(raw || '{}');
    const tool = d.tool_name || '';
    const input = d.tool_input || {};
    const now = new Date();
    const TIME = now.toTimeString().slice(0,8);

    // Skip read-only tools — only capture actions
    const SKIP = ['Read','Grep','Glob','LS','WebFetch','WebSearch','ToolSearch','TaskGet','TaskList','NotebookRead','ListMcpResourcesTool','ReadMcpResourceTool'];
    if (SKIP.includes(tool)) process.exit(0);

    // Extract brief description based on tool type
    let desc = '';
    if (tool === 'Edit' || tool === 'Write') {
      const fp = input.file_path || '';
      // Shorten path: strip vault prefix (forward or backslash)
      const vaultRoot = process.env.AIGENT_ROOT || '.';
      desc = fp.replace(new RegExp('^' + vaultRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[/\\\\]?'), '').replace(/\\/g, '/');
    } else if (tool === 'Bash') {
      // First 80 chars of command
      desc = (input.command || '').substring(0, 80).replace(/\n/g, ' ');
    } else if (tool === 'Agent') {
      desc = input.description || (input.prompt || '').substring(0, 60);
    } else if (tool.startsWith('mcp__')) {
      // MCP tool — extract the meaningful part
      const parts = tool.split('__');
      const server = parts[1] || '';
      const action = parts[2] || '';
      desc = server + '/' + action;
      // Add key param if available
      if (input.query) desc += ': ' + String(input.query).substring(0, 40);
      else if (input.channel_id) desc += ' ch:' + input.channel_id;
    } else if (tool === 'TaskCreate' || tool === 'TaskUpdate') {
      desc = input.subject || input.taskId || '';
    } else if (tool === 'Skill') {
      desc = input.skill || '';
    } else {
      // Generic fallback — tool name only
      desc = JSON.stringify(input).substring(0, 60);
    }

    if (desc) console.log('- ' + TIME + ' | ' + tool + ' | ' + desc);
  } catch(e) { process.exit(0); }
});
