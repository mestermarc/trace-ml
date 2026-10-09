<#
.SYNOPSIS
  Helper for the TraceML Podman dev container.

.EXAMPLE
  .\container\traceml.ps1 build        # build the image
  .\container\traceml.ps1 shell        # interactive bash in the container
  .\container\traceml.ps1 install      # npm ci inside the container
  .\container\traceml.ps1 check        # typecheck + tests + build
  .\container\traceml.ps1 fake-runs --runs 100 --clean
  .\container\traceml.ps1 run <any command...>
#>
param(
    [Parameter(Position = 0)] [string] $Command = 'shell',
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)] [string[]] $Rest
)

$ErrorActionPreference = 'Stop'
$Image   = 'traceml-dev'
$Repo    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    throw 'podman not found. Install Podman Desktop or: winget install RedHat.Podman, then: podman machine init; podman machine start'
}

# In-container paths come from the image (WORKSPACE / UV_CACHE_DIR in the Containerfile), so they are
# defined in one place. Before the first build there is no image yet; 'build' doesn't need them.
function Get-ImageEnv([string] $Name) {
    $envs = podman image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Image 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = $envs | Where-Object { $_ -like "$Name=*" } | Select-Object -First 1
    if ($line) { return $line.Substring($Name.Length + 1) }
    return $null
}

if ($Command -ne 'build') {
    $Workdir = Get-ImageEnv 'WORKSPACE'
    $UvCache = Get-ImageEnv 'UV_CACHE_DIR'
    if (-not $Workdir -or -not $UvCache) { throw "Image '$Image' not found or outdated. Run: .\container\traceml.ps1 build" }
}

# The Windows checkout is bind-mounted; node_modules and the uv cache live in named volumes,
# because esbuild/vitest ship platform-specific binaries that must not mix with the Windows ones.
$RunArgs = @(
    'run', '--rm', '-it',
    # map your host user to the image user (USER_UID / USER_GID in the Containerfile, 1000 by default)
    '--userns=keep-id:uid=1000,gid=1000',
    '-v', "${Repo}:${Workdir}",
    '-v', "traceml-node-modules:${Workdir}/node_modules",
    '-v', "traceml-uv-cache:${UvCache}",
    '-w', $Workdir,
    $Image
)

switch ($Command) {
    'build'     { podman build -t $Image -f (Join-Path $Repo 'container/Containerfile') $Repo @Rest }
    'shell'     { podman @RunArgs bash -l }
    'install'   { podman @RunArgs npm ci }
    'check'     { podman @RunArgs npm run check }
    'test'      { podman @RunArgs npm test }
    'fake-runs' { podman @RunArgs uv run --no-project scripts/fake_runs.py @Rest }
    'run'       { podman @RunArgs @Rest }
    default     { throw "Unknown command '$Command'. Use: build | shell | install | check | test | fake-runs | run" }
}
exit $LASTEXITCODE
