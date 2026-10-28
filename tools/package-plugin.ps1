# Packages premiere-plugin/ as an installable .ccx (a zip with manifest.json at the root).
# Entry names use forward slashes explicitly; Windows PowerShell 5.1's CreateFromDirectory writes
# backslashes, which other zip readers may not treat as folders.
#   powershell -ExecutionPolicy Bypass -File tools\package-plugin.ps1
# Install:  UnifiedPluginInstallerAgent.exe /install <path-to-ccx>
param([string]$Out = "$PSScriptRoot\..\dist\com.premiereremote.panel_premierepro.ccx")

$src = (Resolve-Path "$PSScriptRoot\..\premiere-plugin").Path
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
if (Test-Path $Out) { Remove-Item $Out }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($Out, 'Create')
try {
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $name = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name)
    $name
  }
} finally { $zip.Dispose() }
"wrote $Out"
