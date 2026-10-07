# Changelog

## 0.2.1

- **Run list in the activity bar.** The TraceML view, empty until now, lists the runs by status (running, stale and failed first) with their key metric and age; the title shows the counts. Click a run to open it in the panel's inspector; right-click to copy its folder path or open its log / `metrics.jsonl` read-only. TraceML now polls while the panel or this view is visible.
- **Resizable table columns.** Drag a header's right edge; double-click it for the automatic width. Widths are remembered.
- **Searchable pickers.** Group, the Filter field and the chart field pickers (X, Y, Size, Color, Value, Group) filter their options as you type, with matches highlighted and keyboard selection. A picker opened inside the Filter panel no longer closes it.
- **Fix: "Colour by group" showed a stray box / check mark.** A disabled switch revealed its hidden checkbox (a CSS specificity issue); the switch also shows *off* now when there is no grouping to colour by.
- New `media/curly_m.svg` logo.

## 0.1.18

- **Run database: `traceml/.cache/runs.sqlite`.** A small SQLite file (sql.js, WebAssembly, nothing to install) replaces `runs-index.json`: the table still fills instantly on open, only changed runs are rewritten, and you or an agent can query runs, config and metrics with SQL. A 0.1.17 `runs-index.json` is migrated automatically; if SQLite can't load, TraceML falls back to it.
- **Export chart data.** Every chart (line, scatter, box, bar) has a button that saves its data as plain CSV in `traceml/.cache/plots/`, ready to hand to an agent. Line charts export the full metric history, not the downsampled curve.
- **Filter builder.** Pick a field, an operator (`=`, `!=`, `>`, `>=`, `<`, `<=`, between, contains, not contains, regex) and a value; values are suggested from your runs. The column filter inputs suggest values too and accept `= x`, `!= x`, `~ x` (contains) and `!~ x` (not contains). Existing filters keep working.
- **Upgrade safety.** Tests cover a project left by an older TraceML: the runs are found in the same place, and old cache files (JSON exports, `ui-state.json`, `runs-index.json`) are migrated or ignored, never in the way.

## 0.1.17

- **Faster start, lighter polling.** The parsed runs are saved in `traceml/.cache/runs-index.json`, so the table fills right away when TraceML opens and only changed files are parsed again. Completed, failed and killed runs are no longer re-checked on every poll, only on *Refresh* (and when the panel opens).
- **Delete from TraceML.** *Delete* in the run inspector, or *⋯ → Delete selected from TraceML*, hides runs for good (`traceml/.cache/hidden-runs.json`). Run folders are never touched. *Undo* and *⋯ → Deleted runs…* restore them.
- **Starting values.** A new *Starting values* toggle shows each metric's first logged value (`start` columns, chart fields, inspector, Compare), useful for checking that runs started from the same point.
- **Config / run / summary.** Logged values are labelled as these three kinds everywhere: column tags (`cfg`, `start` / `last` / `best`, `sum`), the column chooser, the inspector, Compare and the export.
- **CSV export.** *Export* now writes `exports/table-*.csv` and `exports/latest.csv` instead of JSON. Columns are named `config.*`, `run.start.*` / `run.last.*` / `run.best.*` and `summary.*`.
- **PNG export.** Every chart (line, scatter, box, bar) has a ⤓ button that saves a 300 DPI PNG (with title and legend) to `traceml/.cache/plots/`.
- **Movable columns.** Drag a column header left or right (or Alt+←/→) to reorder the table; the order is remembered and used by the export.
- **Max rows** accepts any whole number from 1 to 1000 besides the presets and All.
- README: new self-contained section [How to log for TraceML](README.md#how-to-log-for-traceml), written to be handed to a coding agent as is.

## 0.1.16

- The activity bar and the sidebar view use `media/curly_m.svg` again; the bold variant from 0.1.15 is dropped. The panel tab keeps `media/activity.svg`.

## 0.1.15

- Bolder activity-bar and sidebar-view icon (`media/curly_m_bold.svg`): thicker lines and a frame cropped exactly to the drawing, so it no longer looks thin and padded next to other icons. The large TraceML sidebar logo keeps the fine-lined `media/curly_m.svg`.

## 0.1.14

- `media/curly_m.svg` is now a vector drawing (no embedded bitmap, no empty margin): sharp at every size in the activity bar, the sidebar view and the TraceML sidebar logo.
- The panel tab uses the small line icon `media/activity.svg`.

## 0.1.13

- `media/curly_m.svg` is used directly everywhere (activity bar, sidebar view, panel tab, TraceML sidebar logo). The build no longer generates icon variants (`curly-dark.svg`, `curly-light.svg`, `curly-logo-dark.svg`), and `scripts/build-icons.mjs` is no longer used. The sidebar logo is shown white with CSS.

## 0.1.12

- New icon source `media/curly_m.svg` (612×492 px glyph): crisp large logo in the sidebar, and the same source for the activity-bar and tab icons. Stroke thickening now scales with the source size.

## 0.1.11

- The TraceML sidebar (inside the panel) opens with a large logo spanning its full width and the name **TraceML** centred underneath. The large logo keeps the fine original strokes. The collapsed icon rail still shows a small logo.

## 0.1.10

- Icons have zero padding: they're cropped exactly to the glyph and keep its own aspect ratio, instead of being a square with empty bands above and below.

## 0.1.9

- **Cache folder in the project: `traceml/.cache`** (setting `traceml.cacheDir`). The remembered view goes to `ui-state.json` there, and table exports go to `exports/` (`table-*.json` and `latest.json`). They used to live in VS Code's internal storage, which was hard to find; on Remote-SSH the folder is now next to your runs on the server. A view remembered by an older version is still picked up once.

## 0.1.8

- Icons are bolder and fill their slot: the glyph's mask is upscaled 4×, its thin strokes are thickened and it is cropped square without a margin, so it no longer looks small and faint next to other icons in the activity bar and on the panel tab.

## 0.1.7

- Icons are cropped to the glyph at build time (square, centred, small margin), so they fill the activity-bar and tab slots like other VS Code icons instead of looking small.

## 0.1.6

- New logo glyph for the activity bar, the sidebar view, the panel tab and the TraceML sidebar. The source is now `media/curly-icon.svg`; the white (dark theme) and black (light theme) variants are generated from it at build time.

## 0.1.5

- **Max rows.** The run table shows at most 100 rows by default; you can pick 25, 50, 100, 250, 500, 1000 or All. The limit is applied after filters and sorting, and the toolbar shows "showing N of M".
- **Export for agents.** The *Export* button saves the rows currently shown (filters, sort and Max rows applied, visible columns only) as a JSON snapshot in TraceML's cache folder. A banner then shows the path with *Copy path* and *Open*. Run data is never modified.
- **Theme-aware icons.** The activity-bar, sidebar-view and panel-tab icons now use `media/curly.svg`: white on dark themes, black on light themes. The panel-tab variants are generated from `curly.svg` at build time.

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
