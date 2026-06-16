[CmdletBinding()]
param(
  [string]$DestinationRoot = "C:\Users\Franz\OneDrive - novalure eu\Backup CRM",
  [switch]$ExcludeSecrets,
  [int]$KeepLast = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Test-IsPathInside {
  param(
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $parentFull = (Get-FullPath $Parent).TrimEnd('\') + '\'
  $childFull = (Get-FullPath $Child).TrimEnd('\') + '\'
  return $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $baseUri = New-Object System.Uri (($BasePath.TrimEnd('\') + '\'))
  $pathUri = New-Object System.Uri $Path
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString()).Replace('/', '\')
}

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$destinationRoot = Get-FullPath $DestinationRoot

if (Test-IsPathInside -Child $destinationRoot -Parent $sourceRoot) {
  throw "DestinationRoot must be outside the project folder to avoid backing up backups recursively."
}

New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$zipPath = Join-Path $destinationRoot "novalure-crm_$timestamp.zip"

$excludedDirNames = @(
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  ".npm-cache",
  ".pnpm-store",
  ".yarn",
  "coverage",
  "dist",
  "build",
  "playwright-report",
  "test-results"
)

$excludedRelativeDirPrefixes = @(
  ".vercel\output",
  ".vercel\cache"
)

$excludedFileNames = @(
  ".DS_Store",
  "Thumbs.db"
)

$excludedFileExtensions = @(
  ".log",
  ".tmp",
  ".temp"
)

function Test-IsExcludedDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  $name = Split-Path -Leaf $Path
  if ($excludedDirNames -contains $name) {
    return $true
  }

  $relative = Get-RelativePath -BasePath $sourceRoot -Path $Path
  foreach ($prefix in $excludedRelativeDirPrefixes) {
    if (
      $relative.Equals($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith(($prefix + "\"), [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      return $true
    }
  }

  return $false
}

function Test-IsExcludedFile {
  param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

  if ($excludedFileNames -contains $File.Name) {
    return $true
  }

  if ($excludedFileExtensions -contains $File.Extension.ToLowerInvariant()) {
    return $true
  }

  if ($ExcludeSecrets) {
    $lowerName = $File.Name.ToLowerInvariant()
    if ($lowerName -eq ".env" -or $lowerName.StartsWith(".env.")) {
      return $true
    }

    $secretExtensions = @(".pem", ".key", ".p12", ".pfx")
    if ($secretExtensions -contains $File.Extension.ToLowerInvariant()) {
      return $true
    }

    $secretNames = @("id_rsa", "id_ed25519")
    if ($secretNames -contains $lowerName) {
      return $true
    }
  }

  return $false
}

$pendingDirs = New-Object "System.Collections.Generic.Stack[string]"
$files = New-Object "System.Collections.Generic.List[System.IO.FileInfo]"
$pendingDirs.Push($sourceRoot)

while ($pendingDirs.Count -gt 0) {
  $currentDir = $pendingDirs.Pop()
  foreach ($item in Get-ChildItem -LiteralPath $currentDir -Force) {
    if ($item.PSIsContainer) {
      if (-not (Test-IsExcludedDirectory -Path $item.FullName)) {
        $pendingDirs.Push($item.FullName)
      }
      continue
    }

    if (-not (Test-IsExcludedFile -File $item)) {
      $files.Add($item) | Out-Null
    }
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = $null
$backupSucceeded = $false
try {
  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)

  foreach ($file in $files) {
    $entryName = (Get-RelativePath -BasePath $sourceRoot -Path $file.FullName).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $file.FullName,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }

  $secretMode = if ($ExcludeSecrets) { "excluded" } else { "included" }
  $manifest = @"
Novalure CRM backup
Created: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Source: $sourceRoot
Destination: $zipPath
Files: $($files.Count)
Secrets: $secretMode

Excluded generated folders:
$($excludedDirNames -join ", ")
$($excludedRelativeDirPrefixes -join ", ")
"@

  $manifestEntry = $zip.CreateEntry("BACKUP-MANIFEST.txt")
  $manifestStream = $manifestEntry.Open()
  $manifestWriter = New-Object System.IO.StreamWriter($manifestStream, [System.Text.Encoding]::UTF8)
  try {
    $manifestWriter.Write($manifest)
  }
  finally {
    $manifestWriter.Dispose()
  }

  $backupSucceeded = $true
}
finally {
  if ($null -ne $zip) {
    $zip.Dispose()
  }

  if (-not $backupSucceeded -and (Test-Path -LiteralPath $zipPath)) {
    Remove-Item -LiteralPath $zipPath -Force
  }
}

if ($KeepLast -gt 0) {
  Get-ChildItem -LiteralPath $destinationRoot -Filter "novalure-crm_*.zip" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $KeepLast |
    Remove-Item -Force
}

$zipItem = Get-Item -LiteralPath $zipPath
$sizeMb = "{0:N2}" -f ($zipItem.Length / 1MB)

Write-Host "Backup created:"
Write-Host $zipItem.FullName
Write-Host "Size: $sizeMb MB"
Write-Host "Files: $($files.Count)"
if ($ExcludeSecrets) {
  Write-Host "Sensitive files were excluded."
}
else {
  Write-Host "Sensitive files such as .env are included for disaster recovery."
}
