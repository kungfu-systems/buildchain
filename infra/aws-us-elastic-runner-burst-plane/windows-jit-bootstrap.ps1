# SPDX-License-Identifier: Apache-2.0
# Template variables use bounded double-underscore placeholders and contain no
# JIT credential.
<powershell>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Region = "__REGION__"
$JitParameterName = "__JIT_PARAMETER_NAME__"
$EvidenceBucket = "__EVIDENCE_BUCKET__"
$RunnerLabel = "__RUNNER_LABEL__"
$SourceSha = "__SOURCE_SHA__"
$GitHubRunId = "__GITHUB_RUN_ID__"
$GitHubRunAttempt = "__GITHUB_RUN_ATTEMPT__"
$AmiId = "__AMI_ID__"
$AmiName = "__AMI_NAME__"
$RunnerVersion = "2.336.0"
$RunnerArchiveSha256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162"
$PowerShellVersion = "7.6.4"
$PowerShellArchiveSha256 = "d11942df52fd12470169797abfa4781d9480efdc81000ba4fa55a5b921ed8dd0"
$GitVersion = "2.55.0.3"
$GitArchiveSha256 = "ab00566336b5472120f9a52d34f2e79c5406535792acb0548001ffd0bd090e5d"
$StartedAt = (Get-Date).ToUniversalTime()
$RunnerStartedAt = $null
$RunnerExitedAt = $null
$Outcome = "bootstrap-failed"
$ExitCode = 1

function Import-AwsPowerShell {
  if (
    (Get-Module -ListAvailable -Name AWS.Tools.Common) -and
    (Get-Module -ListAvailable -Name AWS.Tools.SimpleSystemsManagement) -and
    (Get-Module -ListAvailable -Name AWS.Tools.S3)
  ) {
    Import-Module AWS.Tools.Common
    Import-Module AWS.Tools.SimpleSystemsManagement
    Import-Module AWS.Tools.S3
    return
  }
  if (Get-Module -ListAvailable -Name AWSPowerShell) {
    Import-Module AWSPowerShell
    return
  }
  throw "AWS Windows AMI does not contain the required AWS.Tools or AWSPowerShell modules"
}

function Get-ImdsDocument {
  $Token = Invoke-RestMethod `
    -Method Put `
    -Uri "http://169.254.169.254/latest/api/token" `
    -Headers @{ "X-aws-ec2-metadata-token-ttl-seconds" = "21600" }
  return Invoke-RestMethod `
    -Method Get `
    -Uri "http://169.254.169.254/latest/dynamic/instance-identity/document" `
    -Headers @{ "X-aws-ec2-metadata-token" = $Token }
}

function Assert-Sha256([string]$Path, [string]$Expected) {
  $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) {
    throw "SHA256 mismatch for $(Split-Path -Leaf $Path)"
  }
}

function Install-PortableGit([string]$Root) {
  $Archive = Join-Path $env:TEMP "PortableGit-$GitVersion-64-bit.7z.exe"
  $Url = "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/PortableGit-2.55.0.3-64-bit.7z.exe"
  Invoke-WebRequest -Uri $Url -OutFile $Archive
  Assert-Sha256 $Archive $GitArchiveSha256
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  $Process = Start-Process -FilePath $Archive -ArgumentList "-y", "-o$Root" -Wait -PassThru
  if ($Process.ExitCode -ne 0) {
    throw "PortableGit extraction failed with exit code $($Process.ExitCode)"
  }
  $env:PATH = "$Root\bin;$Root\cmd;$env:PATH"
}

function Install-PowerShell {
  $Installer = Join-Path $env:TEMP "PowerShell-$PowerShellVersion-win-x64.msi"
  $Url = "https://github.com/PowerShell/PowerShell/releases/download/v$PowerShellVersion/PowerShell-$PowerShellVersion-win-x64.msi"
  Invoke-WebRequest -Uri $Url -OutFile $Installer
  Assert-Sha256 $Installer $PowerShellArchiveSha256
  $Signature = Get-AuthenticodeSignature -FilePath $Installer
  if (
    $Signature.Status -ne "Valid" -or
    $Signature.SignerCertificate.Subject -notmatch "Microsoft Corporation"
  ) {
    throw "PowerShell bootstrap signature is not valid Microsoft code"
  }
  $Process = Start-Process `
    -FilePath "msiexec.exe" `
    -ArgumentList "/i", $Installer, "/qn", "/norestart" `
    -Wait `
    -PassThru
  if ($Process.ExitCode -notin @(0, 3010)) {
    throw "PowerShell installation failed with exit code $($Process.ExitCode)"
  }
  $PowerShellRoot = "C:\Program Files\PowerShell\7"
  if (-not (Test-Path -LiteralPath (Join-Path $PowerShellRoot "pwsh.exe"))) {
    throw "PowerShell installation did not provide pwsh.exe"
  }
  $env:PATH = "$PowerShellRoot;$env:PATH"
}

function Install-MsvcBuildTools {
  $Installer = Join-Path $env:TEMP "vs_BuildTools.exe"
  Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile $Installer
  $Signature = Get-AuthenticodeSignature -FilePath $Installer
  if (
    $Signature.Status -ne "Valid" -or
    $Signature.SignerCertificate.Subject -notmatch "Microsoft Corporation"
  ) {
    throw "Visual Studio Build Tools bootstrap signature is not valid Microsoft code"
  }
  $Arguments = @(
    "--quiet",
    "--wait",
    "--norestart",
    "--nocache",
    "--installPath", "C:\BuildTools",
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--includeRecommended"
  )
  $Process = Start-Process -FilePath $Installer -ArgumentList $Arguments -Wait -PassThru
  if ($Process.ExitCode -notin @(0, 3010)) {
    throw "Visual Studio Build Tools installation failed with exit code $($Process.ExitCode)"
  }
}

function Put-Evidence([string]$InstanceId, [string]$AvailabilityZone) {
  $EvidenceRoot = "C:\kungfu-evidence"
  New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
  $Lifecycle = [ordered]@{
    schemaVersion = 1
    contract = "kungfu-buildchain-aws-windows-jit-lifecycle/v1"
    provider = "aws-ec2"
    instanceId = $InstanceId
    instanceType = $env:AWS_EC2_INSTANCE_TYPE
    availabilityZone = $AvailabilityZone
    amiId = $AmiId
    amiName = $AmiName
    sourceSha = $SourceSha
    githubRunId = $GitHubRunId
    githubRunAttempt = $GitHubRunAttempt
    runnerLabel = $RunnerLabel
    runnerVersion = $RunnerVersion
    runnerArchiveSha256 = $RunnerArchiveSha256
    powerShellVersion = $PowerShellVersion
    powerShellArchiveSha256 = $PowerShellArchiveSha256
    launchedAt = $env:AWS_EC2_LAUNCHED_AT
    bootstrapStartedAt = $StartedAt.ToString("o")
    runnerStartedAt = if ($RunnerStartedAt) { $RunnerStartedAt.ToString("o") } else { $null }
    runnerExitedAt = if ($RunnerExitedAt) { $RunnerExitedAt.ToString("o") } else { $null }
    outcome = $Outcome
    runnerExitCode = $ExitCode
    jitParameterDeletedAfterRead = $env:AWS_EC2_JIT_PARAMETER_DELETED -eq "true"
    shutdownBehavior = "terminate"
    observedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $LifecyclePath = Join-Path $EvidenceRoot "lifecycle.json"
  $Lifecycle | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $LifecyclePath -Encoding UTF8
  $Prefix = "windows/$GitHubRunId/$GitHubRunAttempt/$InstanceId"
  Write-S3Object -BucketName $EvidenceBucket -Key "$Prefix/lifecycle.json" -File $LifecyclePath -Region $Region | Out-Null
  $Diag = "C:\actions-runner\_diag"
  if (Test-Path -LiteralPath $Diag) {
    $Archive = Join-Path $EvidenceRoot "runner-diag.zip"
    Compress-Archive -Path (Join-Path $Diag "*") -DestinationPath $Archive -Force
    Write-S3Object -BucketName $EvidenceBucket -Key "$Prefix/runner-diag.zip" -File $Archive -Region $Region | Out-Null
  }
}

$Document = $null
try {
  Import-AwsPowerShell
  $Document = Get-ImdsDocument
  $InstanceId = [string]$Document.instanceId
  $AvailabilityZone = [string]$Document.availabilityZone
  $env:AWS_EC2_INSTANCE_ID = $InstanceId
  $env:AWS_EC2_INSTANCE_TYPE = "__INSTANCE_TYPE__"
  $env:AWS_EC2_AMI_ID = $AmiId
  $env:AWS_EC2_AMI_NAME = $AmiName
  $env:AWS_EC2_AVAILABILITY_ZONE = $AvailabilityZone
  $env:AWS_EC2_LAUNCHED_AT = "__LAUNCHED_AT__"
  $env:BUILDCHAIN_RUNNER_LABELS_JSON = "[`"self-hosted`",`"Windows`",`"X64`",`"$RunnerLabel`"]"

  Install-PortableGit "C:\PortableGit"
  Install-PowerShell
  Install-MsvcBuildTools

  $RunnerRoot = "C:\actions-runner"
  New-Item -ItemType Directory -Force -Path $RunnerRoot | Out-Null
  $RunnerArchive = Join-Path $env:TEMP "actions-runner-win-x64-$RunnerVersion.zip"
  $RunnerUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip"
  Invoke-WebRequest -Uri $RunnerUrl -OutFile $RunnerArchive
  Assert-Sha256 $RunnerArchive $RunnerArchiveSha256
  Expand-Archive -LiteralPath $RunnerArchive -DestinationPath $RunnerRoot -Force

  $Jit = (Get-SSMParameter -Name $JitParameterName -WithDecryption $true -Region $Region).Value
  Remove-SSMParameter -Name $JitParameterName -Region $Region -Force
  $env:AWS_EC2_JIT_PARAMETER_DELETED = "true"

  Set-Location $RunnerRoot
  $RunnerStartedAt = (Get-Date).ToUniversalTime()
  $env:AWS_EC2_RUNNER_STARTED_AT = $RunnerStartedAt.ToString("o")
  & ".\run.cmd" --jitconfig $Jit
  $ExitCode = $LASTEXITCODE
  $Jit = $null
  $RunnerExitedAt = (Get-Date).ToUniversalTime()
  $env:AWS_EC2_RUNNER_EXITED_AT = $RunnerExitedAt.ToString("o")
  $Outcome = if ($ExitCode -eq 0) { "one-job-complete" } else { "runner-exited-nonzero" }
} catch {
  $Outcome = "bootstrap-error:$($_.Exception.GetType().Name)"
  $ExitCode = 1
} finally {
  try {
    if ($Document) {
      Put-Evidence ([string]$Document.instanceId) ([string]$Document.availabilityZone)
    }
  } catch {
    # The five-minute reaper remains authoritative if evidence upload fails.
  }
  Stop-Computer -Force
}
</powershell>
