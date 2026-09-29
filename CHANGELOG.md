# Changelog

## 0.1.4

- **Your view is remembered.** Plotted metrics, selected runs, filters, sorting, columns, grouping and chart settings come back after closing and reopening TraceML, or reloading the window. They're stored in VS Code's own per-workspace storage, not as a file in your project.
- **Bar chart.** Shows one bar per run, or the group mean with a min–max range. You can choose the value field, the grouping, the sort order and whether bars start at zero. Click a bar to open the run.
- **Visualizations are stacked.** Line, Scatter, Box and Bar appear one under another instead of behind a Line/Scatter/Box switch. Each section can be collapsed, and collapsed sections aren't drawn.
- Box plots got their own Log Y setting.

## 0.1.3

- The default runs folder is now `./traceml/runs`, relative to the opened workspace folder. A leading `./` is accepted. When several folders are listed, missing ones are skipped, and an error appears only when none of them exists.
- Polling pauses while the TraceML panel is hidden behind another tab. It resumes, with a full refresh, when the panel becomes visible again. Nothing runs when the panel is closed.

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
