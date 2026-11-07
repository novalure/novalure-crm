param([Parameter(Mandatory=$true)][string]$SchemaPath, [Parameter(Mandatory=$true)][string]$XmlPath)
$ErrorActionPreference = 'Stop'
$settings = [System.Xml.XmlReaderSettings]::new()
$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$settings.XmlResolver = $null
$settings.ValidationType = [System.Xml.ValidationType]::Schema
$settings.Schemas.XmlResolver = $null
$settings.Schemas.Add('', (Resolve-Path -LiteralPath $SchemaPath).Path) | Out-Null
$script:validationErrors = [System.Collections.Generic.List[string]]::new()
$settings.add_ValidationEventHandler([System.Xml.Schema.ValidationEventHandler]{ param($sender, $eventArgs) if ($eventArgs.Severity -eq [System.Xml.Schema.XmlSeverityType]::Error) { $script:validationErrors.Add($eventArgs.Message) } })
$reader = [System.Xml.XmlReader]::Create((Resolve-Path -LiteralPath $XmlPath).Path, $settings)
try { while ($reader.Read()) {} } finally { $reader.Dispose() }
if ($script:validationErrors.Count -gt 0) { throw ($script:validationErrors -join "`n") }
Write-Output '{"valid":true}'
