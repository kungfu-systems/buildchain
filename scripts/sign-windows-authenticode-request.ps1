$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

foreach ($name in @(
  "BUILDCHAIN_SIGNED_PAYLOAD",
  "BUILDCHAIN_SIGNING_EVIDENCE",
  "BUILDCHAIN_WINDOWS_CERTIFICATE_PFX_BASE64",
  "BUILDCHAIN_WINDOWS_CERTIFICATE_PASSWORD",
  "BUILDCHAIN_WINDOWS_CERTIFICATE_SHA1",
  "BUILDCHAIN_WINDOWS_TIMESTAMP_URL"
)) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "$name is required"
  }
}

$work = Join-Path ([Environment]::GetEnvironmentVariable("RUNNER_TEMP")) ("buildchain-authenticode-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
$pfx = Join-Path $work "authority.pfx"
try {
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:BUILDCHAIN_WINDOWS_CERTIFICATE_PFX_BASE64))
  $signtool = (Get-Command signtool.exe -ErrorAction Stop).Source
  & $signtool sign /fd SHA256 /td SHA256 /tr $env:BUILDCHAIN_WINDOWS_TIMESTAMP_URL /f $pfx /p $env:BUILDCHAIN_WINDOWS_CERTIFICATE_PASSWORD $env:BUILDCHAIN_SIGNED_PAYLOAD
  if ($LASTEXITCODE -ne 0) { throw "signtool sign failed" }
  & $signtool verify /pa /all /v $env:BUILDCHAIN_SIGNED_PAYLOAD
  if ($LASTEXITCODE -ne 0) { throw "signtool verify failed" }

  $signature = Get-AuthenticodeSignature -LiteralPath $env:BUILDCHAIN_SIGNED_PAYLOAD
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) { throw "Authenticode status is not Valid" }
  if ($null -eq $signature.SignerCertificate) { throw "Authenticode signer certificate is missing" }
  if ($signature.SignerCertificate.Thumbprint -ne $env:BUILDCHAIN_WINDOWS_CERTIFICATE_SHA1) { throw "Authenticode publisher fingerprint mismatch" }
  if ($null -eq $signature.TimeStamperCertificate) { throw "Authenticode trusted timestamp is missing" }

  $evidence = [ordered]@{
    schemaVersion = 1
    contract = "kungfu-buildchain-windows-authenticode-evidence/v1"
    status = "passed"
    provider = "microsoft-authenticode"
    publisherSha1 = $signature.SignerCertificate.Thumbprint
    timestampAuthoritySha1 = $signature.TimeStamperCertificate.Thumbprint
    timestampUrl = $env:BUILDCHAIN_WINDOWS_TIMESTAMP_URL
    checks = @("signtool-policy", "sha256-file-digest", "rfc3161-timestamp", "publisher-fingerprint", "powershell-valid")
  }
  $evidence | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:BUILDCHAIN_SIGNING_EVIDENCE -Encoding utf8NoBOM
}
finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
