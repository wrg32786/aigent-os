# install-render.test.ps1: regression vectors for the Windows settings renderer.
# Runs anywhere pwsh runs (CI wires it into the ubuntu validate job). Exits
# non-zero on any failure. Vectors cover the two shipped defects: the bare-word
# regex render that wrapped every path in __ residue AND silently renamed the
# AIGENT_ROOT key itself, and the text-splice escaping that emitted invalid
# JSON escapes (\$) for legal Windows paths like C:\Users\domain$account\....
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..' 'render-settings.ps1')

$template = Join-Path $PSScriptRoot '..' '..' '.claude' 'settings.json.template'
$pass = 0; $fail = 0
function Assert([bool]$cond, [string]$name) {
  if ($cond) { $script:pass++; Write-Host "  PASS  $name" }
  else { $script:fail++; Write-Host "  FAIL  $name" }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("render-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  # Vector 1: plain root against the REAL template.
  $dest = Join-Path $tmp 'settings-plain.json'
  Render-AigentSettings -TemplatePath $template -DestinationPath $dest -Root 'C:\Users\alice\aigent'
  $raw = Get-Content $dest -Raw
  $parsed = $raw | ConvertFrom-Json
  Assert ($null -ne $parsed) 'plain root: rendered settings.json parses'
  Assert (-not $raw.Contains('__AIGENT_ROOT__')) 'plain root: no unsubstituted placeholder'
  Assert (-not ($raw -match '__C:')) 'plain root: no __ residue around rendered paths'
  Assert ($null -ne $parsed.env.PSObject.Properties['AIGENT_ROOT']) 'plain root: AIGENT_ROOT key survives (pre-fix regex renamed the KEY itself)'
  Assert ($parsed.env.AIGENT_ROOT -eq 'C:/Users/alice/aigent') 'plain root: whole-value token gets the RAW root'

  # Vector 2: the reviewer's adversarial-but-legal path (dollar + backtick).
  $dest2 = Join-Path $tmp 'settings-adversarial.json'
  $advRoot = 'C:\Users\domain$account\o' + [char]0x60 + 'dd\aigent'
  Render-AigentSettings -TemplatePath $template -DestinationPath $dest2 -Root $advRoot
  $raw2 = Get-Content $dest2 -Raw
  $parsed2 = $raw2 | ConvertFrom-Json
  Assert ($null -ne $parsed2) 'adversarial root: parses (text-splice emitted Bad JSON escape \$ here)'
  $advFwd = $advRoot.Replace('\', '/')
  Assert ($parsed2.env.AIGENT_ROOT -eq $advFwd) 'adversarial root: whole-value token stays raw, unescaped'
  $cmd = $parsed2.statusLine.command
  Assert ($cmd.Contains('domain\$account')) 'adversarial root: embedded command string carries shell-escaped dollar'

  # Vector 3: token inside an object KEY throws, matching install.sh.
  $badTpl = Join-Path $tmp 'bad-key.json'
  Set-Content $badTpl '{ "__AIGENT_ROOT__/x": "y", "env": { "AIGENT_ROOT": "__AIGENT_ROOT__" } }'
  $threw = $false
  try { Render-AigentSettings -TemplatePath $badTpl -DestinationPath (Join-Path $tmp 'never.json') -Root 'C:\a' } catch { $threw = $true }
  Assert $threw 'token in object key: renderer throws'

  # Vector 4: template with no placeholder throws (render must never silently no-op).
  $noTok = Join-Path $tmp 'no-token.json'
  Set-Content $noTok '{ "env": { "AIGENT_ROOT": "hardcoded" } }'
  $threw2 = $false
  try { Render-AigentSettings -TemplatePath $noTok -DestinationPath (Join-Path $tmp 'never2.json') -Root 'C:\a' } catch { $threw2 = $true }
  Assert $threw2 'placeholder-free template: renderer throws'
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$pass passed, $fail failed."
if ($fail -ne 0) { exit 1 }
exit 0
