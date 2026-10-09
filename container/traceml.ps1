<#
.SYNOPSIS
  Helper for the TraceML Podman dev container.

.EXAMPLE
  .\container\traceml.ps1 build        # build the image
  .\container\traceml.ps1 shell        # interactive bash as "beta"
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
$Workdir = '/home/beta/trace-ml'

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    throw 'podman not found. Install Podman Desktop or: winget install RedHat.Podman, then: podman machine init; podman machine start'
}

# The Windows checkout is bind-mounted; node_modules and the uv cache live in named volumes,
# because esbuild/vitest ship platform-specific binaries that must not mix with the Windows ones.
$RunArgs = @(
    'run', '--rm', '-it',
    '--userns=keep-id:uid=1000,gid=1000',
    '-v', "${Repo}:${Workdir}",
    '-v', "traceml-node-modules:${Workdir}/node_modules",
    '-v', 'traceml-uv-cache:/home/beta/.cache/uv',
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
