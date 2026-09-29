# Changelog

## 0.1.2

- **Only configured folders are read.** `traceml.roots` now lists runs folders explicitly (default `["runs"]`, relative to the workspace, or an absolute path). There's no more recursive workspace search, and the `traceml.exclude` and `traceml.maxDepth` settings were removed.
- **Read confinement.** Every read resolves symlinks first. Runs or files whose real location is outside the runs folder are ignored and reported.
- **Read-only file viewer.** Files opened from the inspector use a read-only file system and can't be edited or saved through TraceML.
- **Security test suite** (`test/security.test.ts`). It fails the build if a filesystem write, process spawn or network API is added.
- `traceml.maxMetricsFileMB` default lowered from 256 to 64.
- New extension icon. TraceML is declared safe for Restricted Mode (untrusted workspaces).
- README: a complete run-format specification for people and AI agents, plus a stdlib-only reference logger (`scripts/traceml_logger.py`).

## 0.1.1

- Activity-bar icon and sidebar view.
- Memory guards: small files over 16 MB aren't parsed, and `traceml.maxMetricsFileMB` was added.

## 0.1.0

- First release: run table, filtering, sorting, grouping, line/scatter/box plots, run inspector, comparison, live refresh, dark-only UI.
