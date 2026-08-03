# render-settings.ps1: shared settings.json renderer for the Windows installer.
# Parse -> walk -> escape -> serialize, mirroring install.sh's renderer exactly:
# a whole-value __AIGENT_ROOT__ becomes the raw root; a token embedded inside a
# larger string (the template's bash-double-quoted command lines) gets shell
# escaping; serialization goes back through ConvertTo-Json so any backslashes
# the escaping adds become VALID JSON escapes. Splicing escaped text into the
# raw JSON emitted \$ / \` sequences that JSON refuses, so a legal Windows path
# like C:\Users\domain$account\aigent aborted the installer at parse time.
# A token inside an object KEY throws, matching install.sh.
function Convert-AigentSettingsNode {
  param($Node, [string]$RootFwd, [string]$RootShell)
  if ($Node -is [string]) {
    if ($Node -eq '__AIGENT_ROOT__') { return $RootFwd }
    if ($Node.Contains('__AIGENT_ROOT__')) { return $Node.Replace('__AIGENT_ROOT__', $RootShell) }
    return $Node
  }
  if ($Node -is [System.Collections.IList]) {
    $out = @()
    foreach ($item in $Node) { $out += , (Convert-AigentSettingsNode $item $RootFwd $RootShell) }
    return , $out
  }
  if ($Node -is [pscustomobject]) {
    foreach ($prop in $Node.PSObject.Properties) {
      if ($prop.Name.Contains('__AIGENT_ROOT__')) { throw 'settings placeholder is not allowed in an object key' }
      $prop.Value = Convert-AigentSettingsNode $prop.Value $RootFwd $RootShell
    }
    return $Node
  }
  return $Node
}

function Render-AigentSettings {
  param(
    [Parameter(Mandatory)][string]$TemplatePath,
    [Parameter(Mandatory)][string]$DestinationPath,
    [Parameter(Mandatory)][string]$Root
  )
  $rootFwd = $Root.Replace('\', '/')
  $rootShell = $rootFwd.Replace('\', '\\').Replace('"', '\"').Replace('$', '\$').Replace("``", "\``")
  $raw = Get-Content $TemplatePath -Raw
  if (-not $raw.Contains('__AIGENT_ROOT__')) { throw 'settings template contains no __AIGENT_ROOT__ placeholder' }
  $tree = $raw | ConvertFrom-Json
  $tree = Convert-AigentSettingsNode $tree $rootFwd $rootShell
  $json = ($tree | ConvertTo-Json -Depth 64) + "`n"
  [System.IO.File]::WriteAllText($DestinationPath, $json)
}
