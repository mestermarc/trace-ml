# TraceML
![logo](media/extension_logo.png)


TraceML is a VS Code extension for browsing ML training runs. It finds runs on the filesystem and shows them in a panel inside VS Code: a run table with filtering and sorting, metric plots, a detail view for each run, and side-by-side comparison.

The filesystem is the only source of truth. There is no server, no database, no HTTP endpoint and no browser app. Everything runs inside VS Code, including over **Remote-SSH**, where the extension reads the runs directly on the remote machine.

**TraceML is read-only for your runs.** It never creates, modifies or deletes anything in your run folders (even *Delete* only hides a run in TraceML), it makes no network calls, and it reads only inside the runs folders you configure. Its own small files (remembered view, run database, CSV exports, saved plots) go to `traceml/.cache`. See [Security and resource use](#security-and-resource-use).

**Quick start**

1. Make your training code write runs in the TraceML format. The short version, written so you can hand it to a coding agent as is, is [How to log for TraceML](#how-to-log-for-traceml); the full specification is [the TraceML run format](#writing-runs-the-traceml-run-format).
2. Write the runs to `./traceml/runs` inside the opened folder, which is read by default. Otherwise set `traceml.roots` to your runs folder, e.g. `"./runs"` or `"/data/me/project/runs"`.
3. Click the TraceML icon in the activity bar, or run **TraceML: Show Experiments**.

```
runs/                        ┌─────────────────────────────────────────┐
├── run-A/      ──TraceML──▶ │ run table · filters · sorting           │
├── run-B/                   │ metric plots (train/loss, val/auc, …)   │
└── run-C/                   │ run detail / comparison                 │
                             └─────────────────────────────────────────┘
```

## How to log for TraceML

> **For agents:** this section is self-contained. To add TraceML logging to a training script, follow it exactly; you need nothing else from this README.

**What TraceML needs:** every training run writes one folder of small text files. TraceML (a VS Code viewer) only reads these files. There is no server, no account and no package to install.

### Step 1: one folder per run

Create a new folder for every run, inside `traceml/runs/` at the project root:

```
traceml/runs/<run_id>/
```

`run_id` = `<UTC date YYYYMMDD-HHMMSS>_<short name>_<4 random hex chars>`, for example `20261002-141500_baseline_a3f1`.

### Step 2: know the three kinds of values

| Kind | What it is | Examples | When to write | Where it goes |
| --- | --- | --- | --- | --- |
| **config** | Settings the run starts with | learning rate, batch size, model name, dataset | once, at the start | `params.yaml` |
| **run** | Metrics that change during training | `train/loss`, `val/loss`, `val/auc`, `lr` | once or twice per epoch | `metrics.jsonl` (history) and `metrics.json` (`last` / `best`) |
| **summary** | Final results that have no history | `test/auc`, `test/accuracy`, best checkpoint path | once, at the end | `metrics.json` → `summary` |

The run's name and status go into `run.json`.

### Step 3: the files

`params.yaml` holds the **config**, one flat `key: value` per line, written at the start:

```yaml
optim.lr: 0.0003
data.batch_size: 64
model.name: "resnet18"
```

`metrics.jsonl` holds the **run** values. Append one JSON object per line on every log call. `step` and `epoch` are the epoch number, `time` is Unix seconds, and every other key is a metric:

```json
{"step": 0, "epoch": 0, "time": 1790000000.1, "train/loss": 0.91, "lr": 0.0003}
{"step": 0, "epoch": 0, "time": 1790000004.5, "val/loss": 0.95, "val/auc": 0.71}
```

`metrics.json` is rewritten after every log call. It holds the latest step, the `last` and `best` **run** values, and the **summary**:

```json
{"schema_version": 1, "updated_at": "2026-10-02T14:20:00Z", "step": 9, "epoch": 9,
 "last": {"train/loss": 0.21, "val/loss": 0.30, "val/auc": 0.88, "lr": 0.0001},
 "best": {"val/auc": {"value": 0.89, "step": 7, "epoch": 7, "mode": "max"}},
 "summary": {"test/auc": 0.87}}
```

`run.json` is written at the start, refreshed at least every 30 seconds (the heartbeat), and written again at the end:

```json
{"schema_version": 1, "id": "20261002-141500_baseline_a3f1", "name": "baseline", "group": null, "tags": [],
 "notes": "", "status": "running", "started_at": "2026-10-02T14:15:00Z", "ended_at": null,
 "heartbeat_at": "2026-10-02T14:15:30Z", "duration_s": null, "exit": null}
```

At the end: `status` is `completed`, `failed` or `killed`; `ended_at` and `duration_s` are set; and `exit` is `{"code": 0, "signal": null}`. A failure adds `"error_type"`, `"error_message"` and `"traceback"`.

### Step 4: follow these rules

1. **Replace** `run.json`, `params.yaml` and `metrics.json` atomically: write `.<name>.tmp` in the same folder, then `os.replace()` it onto the real name. Never edit them in place.
2. **Only append** to `metrics.jsonl`: one complete line ending in `\n` per write.
3. Metric values are numbers or `null` only. Never write NaN or Infinity; write `null` instead.
4. Prefix metric names with `train/`, `val/`, `test/` or `sys/`. Use the same names in every run.
5. Log once or twice per **epoch**, not per batch.
6. **Always finish the run**, also when training crashes or is interrupted (use `try` / `except`).
7. Timestamps in `run.json` and `metrics.json` are UTC ISO-8601 (`2026-10-02T14:15:00Z`); `time` in `metrics.jsonl` is Unix seconds.

### Step 5: copy this logger (Python, standard library only)

```python
import json, os, secrets, time, traceback
from datetime import datetime, timezone


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write(path, text):  # atomic: readers never see a half-written file
    tmp = os.path.join(os.path.dirname(path), "." + os.path.basename(path) + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def _num(v):  # metric value -> float or None (never NaN / Infinity)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


class TraceML:
    def __init__(self, name, config, runs_dir="traceml/runs", best=None, group=None, tags=()):
        self.t0 = self.beat = time.time()
        self.id = f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S}_{name}_{secrets.token_hex(2)}"
        self.dir = os.path.join(runs_dir, self.id)
        os.makedirs(self.dir)
        self.best_modes = best or {}  # e.g. {"val/auc": "max", "val/loss": "min"}
        self.last, self.best, self.summary, self.step = {}, {}, {}, None
        self.meta = {"schema_version": 1, "id": self.id, "name": name, "group": group, "tags": list(tags),
                     "notes": "", "status": "running", "started_at": _iso(self.t0), "ended_at": None,
                     "heartbeat_at": _iso(self.t0), "duration_s": None, "exit": None}
        # config: flat "key: value" lines (JSON scalars are valid YAML)
        _write(os.path.join(self.dir, "params.yaml"), "".join(f"{k}: {json.dumps(v)}\n" for k, v in config.items()))
        self._save()

    def log(self, epoch, metrics):  # run values: call once or twice per epoch
        row = {"step": epoch, "epoch": epoch, "time": time.time()}
        for k, v in metrics.items():
            v = row[k] = self.last[k] = _num(v)
            mode, old = self.best_modes.get(k), self.best.get(k)
            if mode and v is not None and (old is None or (v > old["value"] if mode == "max" else v < old["value"])):
                self.best[k] = {"value": v, "step": epoch, "epoch": epoch, "mode": mode}
        with open(os.path.join(self.dir, "metrics.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        self.step = epoch
        self._save()

    def heartbeat(self):  # call often during long epochs (cheap: writes at most every 10 s)
        if time.time() - self.beat >= 10:
            self._save()

    def finish(self, status="completed", error=None):  # status: completed | failed | killed
        t = time.time()
        self.meta.update(status=status, ended_at=_iso(t), duration_s=round(t - self.t0, 3),
                         exit={"code": 0 if status == "completed" else 1, "signal": None})
        if error is not None:
            self.meta["exit"].update(error_type=type(error).__name__, error_message=str(error),
                                     traceback="".join(traceback.format_exception(type(error), error, error.__traceback__)))
        self._save()

    def _save(self):
        self.beat = time.time()
        self.meta["heartbeat_at"] = _iso(self.beat)
        _write(os.path.join(self.dir, "run.json"), json.dumps(self.meta, indent=2))
        summary = {k: (_num(v) if isinstance(v, (int, float)) else v) for k, v in self.summary.items()}
        _write(os.path.join(self.dir, "metrics.json"), json.dumps(
            {"schema_version": 1, "updated_at": _iso(time.time()), "step": self.step, "epoch": self.step,
             "last": self.last, "best": self.best, "summary": summary}, indent=2))
```

Use it in the training script like this:

```python
run = TraceML("baseline", config={"optim.lr": 3e-4, "data.batch_size": 64, "model.name": "resnet18"},
              best={"val/auc": "max", "val/loss": "min"})                      # config
try:
    for epoch in range(num_epochs):
        for batch in train_loader:
            ...                                    # training step
            run.heartbeat()                        # keeps the run "alive" during long epochs
        run.log(epoch, {"train/loss": train_loss, "lr": lr})                    # run values
        run.log(epoch, {"val/loss": val_loss, "val/auc": val_auc})
    run.summary["test/auc"] = test_auc                                           # summary
    run.finish("completed")
except KeyboardInterrupt:
    run.finish("killed")
    raise
except BaseException as e:
    run.finish("failed", e)
    raise
```

`runs_dir` defaults to `traceml/runs` relative to the current working directory; pass an absolute path when the script runs from another folder.

To check the result, open the project in VS Code and click the TraceML icon. The run shows up in the table: config columns are tagged `cfg`, run metrics `best` / `last` (`start` with *Starting values* on), and summary values `sum`.

---

## Installation

TraceML is shipped as a `.vsix` file.

1. Build it (see [Development](#development)) or get `traceml-<version>.vsix` from whoever built it.
2. In VS Code, open the Extensions view, click **⋯ → Install from VSIX…** and pick the file.
   From a terminal you can run `code --install-extension traceml-0.1.0.vsix` instead.
3. **Remote-SSH:** open the remote window first, then install the `.vsix` into it. The extension declares `"extensionKind": ["workspace"]`, so it runs on the remote host. The "Install from VSIX…" menu in a remote window installs it there.

The packaged extension doesn't need Node, npm or any other process running.

## Commands

| Command | What it does |
| --- | --- |
| TraceML icon in the activity bar | Opens the **run list** in the sidebar (see below) and the TraceML panel. |
| **TraceML: Show Experiments** | Opens the TraceML panel, or brings it to the front if it's already open. |
| **TraceML: Refresh** | Re-lists the configured runs folders and re-reads changed files right away. |

### The run list in the activity bar

The TraceML view in the activity bar lists your runs by status, so you can see what's training and what crashed while you edit code:

- **Running**, **Stale** and **Failed** come first and are expanded; **Completed**, **Killed** and **Unknown** are collapsed. Newest runs first.
- Each run shows its key metric (first `best` value, else a numeric summary), the step while running, and its age (e.g. `val/auc 0.894 · step 12 · 2h`). Hover for id, group, tags and file problems.
- The view title shows the counts, e.g. `24 runs · 1 running · 4 failed`.
- **Click a run** to open it in the panel (Runs view, inspector, row scrolled into view). **Right-click** for *Copy Run Folder Path*, *Open Log* and *Open metrics.jsonl* (read-only). The title bar has *Refresh* and *Show Experiments*.
- Runs deleted from TraceML aren't listed. The list uses the data TraceML already has (no extra file reads); TraceML polls while the panel **or** this view is visible.
- With no runs yet, the view shows the *Open Experiments* / *Refresh* links and where runs are read from.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `traceml.roots` | `["./traceml/runs"]` | The runs folders to read. Each entry is a folder whose **direct sub-folders are runs**: a path relative to each workspace folder (`./traceml/runs`, `./runs`, `outputs/runs`) or an absolute path (`/data/me/runs`, `D:\runs`). Entries that don't exist are skipped, and an error is shown only when none is found. Only these folders are read. There's no recursive search, and patterns aren't supported. |
| `traceml.refreshIntervalSeconds` | `5` | How often TraceML polls for changes, in seconds. |
| `traceml.staleAfterSeconds` | `60` | A `running` run whose heartbeat is older than this is shown as `stale`. |
| `traceml.maxPointsPerSeries` | `5000` | Series longer than this are downsampled before plotting. |
| `traceml.cacheDir` | `./traceml/.cache` | TraceML's own folder: the remembered view (`ui-state.json`), the run database (`runs.sqlite`), the runs deleted from TraceML (`hidden-runs.json`), CSV exports (`exports/`) and saved plots and plot data (`plots/`). Relative to the first workspace folder, or an absolute path. It's the only place TraceML writes. |
| `traceml.maxMetricsFileMB` | `64` | At most this many MB of each plotted run's `metrics.jsonl` are loaded into memory. A larger file is plotted partially, with a warning. |

## The UI

TraceML uses a dark-only application shell with its own design system, inside a single VS Code webview. It has a sidebar, a header and three views.

```
┌──────────────┬───────────────────────────────────────────┬───────────────┐
│ TraceML    ‹ │ TraceML / Runs          24 runs  ● 1 stale │     Refresh   │
│ Overview     ├───────────────────────────────────────────┼───────────────┤
│ Runs      24 │ [Search…]            Filter Group Columns │ run inspector │
│ Compare    4 │ All · Running · Stale · Failed   Differ   │ (details of   │
│ RUN ROOTS    │ [status: failed ×] [grouped by: lr ×]     │  the clicked  │
│  runs     24 │ run table (virtualized, grouped)          │  run)         │
│ SELECTED     │ Visualization  Line | Scatter | Box       │               │
│  4 runs      │ [+ Metrics] [train/loss ×]  X  Log Y  …   │               │
│ Settings     │ charts                                    │               │
└──────────────┴───────────────────────────────────────────┴───────────────┘
```

- **Sidebar:**
  - *Navigation:* Overview, Runs and Compare. Runs and Compare show the total and selected run counts.
  - *Run roots:* the discovered runs roots with their run counts. Click one to show only its runs, and click again to clear that filter.
  - *Selected:* the selection count, plus *Compare* and *Clear*.
  - *Settings:* opens the TraceML settings in VS Code.
  - The sidebar collapses to an icon rail with the ‹ button, and does so automatically in narrow panels.
- **Header:** the current section, run count, running/stale/failed counts, *Last refreshed* time (with a small spinner while refreshing) and a *Refresh* button.
- **Overview:** status counts (click one to jump to those runs), active runs (running or stale, with their heartbeat age), the most recent runs with a key metric, and the run roots.
- **Runs** is the main workspace:
  - **Search** covers id, name, group and tags. Esc clears it.
  - **Filter** opens a panel for adding column conditions: pick a **field**, an **operator** and a **value**.
    - Operators for numbers: `=`, `!=`, `>`, `>=`, `<`, `<=`, *between* (`0.1..0.5`), *contains*, *not contains*. For text: `=`, `!=`, *contains*, *not contains*, *regex*.
    - The value box **suggests values from your runs** (most frequent first), e.g. `adamw`, `sgd` for `optim.name`.
    - Field pickers (Filter field, Group, and the X / Y / Size / Color / Value / Group pickers of the charts) are **searchable**: open one and type, or just start typing on it. Every word you type must match; matches are highlighted.
    - Text matching ignores case. Runs without a value for the field never match a condition.
    - The same panel can also show per-column filter inputs under the table headers. They suggest values too, and accept the operators typed directly: `> 0.8`, `0.1..0.5`, `= adamw`, `!= adamw`, `~ adam` (contains), `!~ adam` (not contains), `/regex/`, or plain text (contains). Filters saved by older versions keep working.
    - **Dates:** the *started*, *ended* and *heartbeat* columns, and config or summary fields whose values are all dates (`2026-09-28`, `2026-09-28 14:30`, ISO date-times with `Z` or `+02:00`), are compared as dates, not text. The builder shows date pickers (the time is optional: empty means the whole day) with *on*, *not on*, *before*, *after*, *on or before*, *on or after* and *between*. In the column inputs type `< 2026-09-01`, `>= 2026-09-01 08:00`, `= 2026-09-28` (that day), `2026-09-01..2026-09-30` (both days included) or just a date. Dates without a time zone are local time, like the table; values with an offset are compared at their actual instant. Number and text filters are unchanged.
  - **Status segment:** *All* · Running · Stale · Completed · Failed · Killed · Unknown, with counts. You can combine several statuses.
  - **Differing params only:** shows only the config columns whose values differ between the filtered runs.
  - **Starting values:** adds each metric's starting value (its first logged, non-null value in `metrics.jsonl`) as `start` columns next to the metrics already shown. It also adds them to the Columns chooser, the scatter/box/bar fields, the inspector and the Compare view, so you can see whether runs started from the same point.
  - **Group** groups by status, group, tags, name, any config value, or a text summary field. The list is searchable: type part of a name (e.g. `batch`) and pick with ↑/↓ and Enter.
    - **Several grouping fields:** click a field to group by it alone, or use its **+** button (or Shift+Enter) to add it as another level, e.g. treatment group + scanner + dataset. Runs are then grouped by each combination of the values (`cifar10 · adamw`); **−** or the chips remove a field. Group statistics, *Colour by group*, *Plot by groups* and every chart whose group is *auto* use all active fields.
    - Each group gets a collapsible header row showing its color, value, run count and how many runs are selected. The header's checkbox selects the whole group.
    - The header row also shows the **group mean (μ)** of every numeric column (config values, run metrics, summary values, duration, step). Hover for n, min, max and standard deviation.
    - Groups are ordered by value, with `(none)` last. Sorting applies within each group.
  - **Max rows** (next to the run count) limits the table to the first N rows: pick 25, 50, **100** (the default), 250, 500, 1000 or All, or type any whole number from 1 to 1000. The limit is applied after filters and sorting, and the toolbar shows "showing N of M". Charts and *Select filtered* still use all filtered runs.
  - **Export** saves the table as you see it as a CSV file; see [Exporting the table for an agent](#exporting-the-table-for-an-agent).
  - **Columns** is the column chooser, grouped as Run info, Config, Run (start / last / best value) and Summary. **⋯** holds *Select filtered*, *Clear selection*, *Delete selected from TraceML*, *Deleted runs…*, *Clear filters*, *Collapse/Expand all groups* and *Reset columns*.
  - **Delete from TraceML** (⋯ menu for the selected runs, or *Delete* in the inspector) hides runs from TraceML for good. The run folders and files are **not** touched. Deleted runs are no longer read, which also keeps polling fast. A bar offers *Undo*, and *⋯ → Deleted runs…* lists them with *Restore*. The list is stored in `traceml/.cache/hidden-runs.json`.
  - **Active filters** (search, statuses, conditions, grouping, differing-only) appear as removable chips, with *Clear all*.
  - **Run table:**
    - The fixed columns are select, status, name, group, started, duration and step. The dynamic columns are the three kinds of logged values: **config** (`params.yaml`, tagged `cfg`), **run** (the metric history: `best` and `last` from `metrics.json`, plus `start` with *Starting values* on) and **summary** (`metrics.json` summary, tagged `sum`).
    - By default the table shows the fixed columns, all `best` and `summary` metrics, and up to six config values that differ between the runs.
    - Click a header to sort; Shift-click adds a secondary sort key. Nulls always sort last.
    - **Move columns** by dragging a header left or right (a blue line marks where it lands), or with Alt+←/→ on a focused header. The order is remembered and used by *Export*.
    - **Resize columns** by dragging the right edge of a header; double-click the edge to go back to the automatic width. Widths are remembered.
    - Status pills combine a dot and a label: running, completed, failed, killed, stale (with a hollow dot), and unknown.
    - An amber warning icon after a run name marks *file problems*, such as corrupt or missing files, malformed metric lines, or a newer schema. That's separate from a *failed* run status. Hover over it for details; they're also listed in the inspector.
    - Only the rows on screen exist in the DOM, and rows are reused across live refreshes. Drag the bottom edge to resize the table.
    - Keyboard: ↑/↓ and Home/End move the focus, Space selects, Esc closes the inspector.
  - **Visualizations** are stacked one under another: **Line**, **Scatter**, **Box** and **Bar**. Each section can be collapsed (a collapsed section isn't drawn), and has its own controls. The workflow is: filter, then select or group, then choose fields, then inspect, then click a run to see its details.
    - **Line** (the metric history in `metrics.jsonl`, for the selected runs):
      - *+ Metrics* opens a searchable picker grouped into TRAIN / VAL / TEST / SYSTEM / OTHER. The plotted metrics appear as removable chips.
      - The x-axis can show step, epoch, or wall time (relative to `started_at`). There's also Log Y, EMA smoothing from 0 to 0.99 (with the raw line kept faintly visible), and *Colour by group*.
      - Each chart shows one metric with one line per run. Each run keeps a stable color.
      - Hovering highlights the nearest line and shows a tooltip. Click a legend entry to hide or show a run, or double-click it to open the run.
      - Drag across a chart to zoom, and double-click to reset. Live updates keep your zoom.
      - The ⤓ button on a chart saves it as a **300 DPI PNG** (title, chart and legend, at the current zoom) to `traceml/.cache/plots/`. A bar shows the path, with *Copy path* and *Open*.
      - The 🗎 button saves the chart's **data as CSV** instead, for agents: the full (not downsampled) history of the metric for the plotted runs, one row per logged value (`run,path,step,epoch,time_s,<metric>`). See [Exporting chart data](#exporting-chart-data).
      - `null` values show as gaps; a missing value is simply absent. At most 30 runs are plotted.
      - **Plot by groups** (needs a table grouping): one curve per group, the mean of its selected runs at each step (by epoch in epoch mode; wall time uses the mean time of each step). Runs that stopped early simply stop contributing; the tooltip shows how many runs are behind each point. Runs hidden in the legend are left out.
    - **Scatter** (all filtered runs, run-level data only):
      - X and Y can be any numeric field, and you can swap them. There's an optional *Size* field, a *Color* field (*auto* follows the grouping), and Log X / Log Y.
      - Runs with missing, `null`, NaN, non-numeric or (on a log axis) ≤ 0 values are left out, and the count is shown.
      - Hover over a point for its values; click it to open the run.
      - **Plot by groups** (needs a Color field or a table grouping): one point per group at the mean X and Y, with ±1 standard deviation whiskers.
      - **X range / Y range** set the axis limits by hand: type a min, a max or both (empty = automatic; *Auto* resets both axes). Points outside the range are hidden from the chart (the count is shown) but stay in the data and the CSV export. Invalid limits (not a number, min ≥ max, ≤ 0 on a log axis) are flagged and not applied. Limits are remembered, and reset when you pick another X or Y field.
    - **Box** (all filtered runs): one box per group, showing the quartiles, the median, and whiskers reaching to 1.5 × IQR. **Plot by groups** adds the group mean (◆). Every run is drawn as a jittered point, with outliers hollow. Hover for details, or click a point to open the run.
    - **Bar** (all filtered runs, run-level data only):
      - *One per run* draws horizontal bars, colored by the Group field if one is set, with at most 60 bars; filter to narrow down. Click a bar to open the run.
      - **Plot by groups** draws one bar per group (the group mean) with a whisker from min to max and the run count.
      - Sort by highest first, lowest first or table order. *Start at zero* (on by default) keeps bar lengths honest; turn it off to fit the axis to the data range. Sorting is a display choice only; TraceML never ranks runs.
    - The ⤓ button in the Scatter, Box and Bar section headers saves that chart as a 300 DPI PNG, like the line charts. The 🗎 button next to it saves the chart's data as CSV.
- **Remembered view:** the plotted metrics, selected runs, filters, sort order, columns and their order, grouping, chart settings and collapsed sections are restored when you reopen TraceML or reload the window. They're saved in `traceml/.cache/ui-state.json` (see `traceml.cacheDir`).
- **Run inspector:** a side panel that opens when you click a run in any view.
  - *Header:* name, status, group, start time, tags and id, plus *Select* and *Delete* (hide from TraceML; files are not touched) buttons.
  - *Error callout* (for failed runs): error type, message, exit code and the traceback tail.
  - *File-problem callout* (for runs with corrupt, missing or newer-schema files).
  - *Overview:* duration, step, epoch, heartbeat and key metrics.
  - *Metrics:* best and summary values, with last values (and starting values, when shown) in their own sections.
  - *Config* (`params.yaml`), the *Full config* tree (`config.json`) and *Run info* (command, cwd, host/runtime, git).
  - *Files* opens `params.yaml`, `config.json`, `metrics.jsonl`, `logs/run.log`, `run.json` or `metrics.json` in the editor.
  - Sections can be collapsed, and they stay collapsed across live refreshes. In narrow panels the inspector floats over the content.
- **Compare** (two or more selected runs): a run strip using the same colors as the charts, then a Config table and a Run & summary table (start value when shown, last, best, summary) side by side.
  - Sticky headers and first column. Rows that differ are marked ≠ and lightly tinted. *Only differences* hides the identical rows.
  - Click a run header to open the run. TraceML never ranks runs or picks a winner.
- **Empty and loading states:** scanning, no experiments (with *Refresh*), no filter matches (with *Clear filters*), no selection, no metrics, and loading charts. Host errors appear as a dismissable bar under the header.

**Design system.** All colors, radii, spacing and type sizes are CSS tokens in `src/webview/styles/tokens.css` (`--tm-bg`, `--tm-surface`, `--tm-surface-raised`, `--tm-border`, `--tm-text-*`, `--tm-accent`, `--tm-success/warning/error/info`, `--tm-radius-*`, `--tm-space-*`, `--tm-series-*`, and so on). The component CSS contains no hard-coded colors.

- The UI is dark in every VS Code theme. With a high-contrast theme, borders and focus rings use the host's contrast colors.
- Status is never shown by color alone: pills have text, and stale uses a hollow dot.
- Every control is keyboard reachable with a visible focus ring, and icon-only buttons have accessible names.
- Motion is short, and it's disabled when the OS asks for reduced motion.

## Writing runs: the TraceML run format

This section is the **authoritative specification** for producing runs that TraceML can display. It's written so that a person, or an AI coding agent asked to "add TraceML logging to this training script", can implement it exactly. Everything here is `schema_version: 1`.

### 1. Directory layout

```
<runs folder>/                      ← an entry of traceml.roots (default: ./traceml/runs)
└── <run_id>/                       ← one directory per run; run_id = directory name
    ├── run.json          required  run metadata + status + heartbeat
    ├── params.yaml       required  flat hyper-parameters
    ├── config.json       optional  full nested config (shown as a tree)
    ├── metrics.jsonl     required  metric history, one JSON object per line (append-only)
    ├── metrics.json      required  derived summary: last / best / summary values
    ├── logs/run.log      optional  plain-text log (opened from the UI)
    ├── checkpoints/      optional  not read by TraceML
    ├── artifacts/        optional  not read by TraceML
    ├── manifest.json     optional  not read by TraceML
    ├── split.json        optional  not read by TraceML
    └── git.diff          optional  not read by TraceML
```

- **`run_id`:** use `YYYYMMDD-HHMMSS_<name>_<4 hex>` in UTC, e.g. `20260929-154600_mlp-baseline_a3f1`. It must be unique and must not start with `.`.
- **Dot files:** files and directories starting with `.` are ignored. Use them for temporary files (see the write rules).
- **What counts as a run:** a directory is a run if it contains at least one of `run.json`, `metrics.json`, `metrics.jsonl`, `params.yaml` or `config.json`.
- **Depth:** only the **direct** sub-directories of a runs folder are runs. Nested runs are not discovered.

### 2. Write rules (important for live viewing)

TraceML reads these files while training is still writing them. Follow these rules and the viewer never sees broken data:

1. **Replace the whole-file JSON/YAML files atomically.** This applies to `run.json`, `metrics.json`, `params.yaml` and `config.json`. Write to a dot-prefixed temp file in the same directory (e.g. `.run.json.tmp`), flush, then `os.replace(tmp, final)`. Never rewrite them in place.
2. **Only ever append to `metrics.jsonl`.** Write one complete JSON object plus `"\n"` per write, then flush. Never rewrite or truncate it; a shrinking file makes TraceML reload it from the start.
3. **Use UTF-8 everywhere, and put timestamps in UTC ISO-8601** (`2026-09-29T13:46:00Z`) in `run.json` and `metrics.json`. In `metrics.jsonl`, `time` is Unix seconds (a float).
4. **Keep the heartbeat fresh.** While running, update `run.json.heartbeat_at` at least every 30 s. A running run whose heartbeat is older than `traceml.staleAfterSeconds` (default 60 s) is shown as **stale**.
5. **Always finish the run.** On exit, set `status` (`completed`, `failed` or `killed`), `ended_at`, `duration_s` and `exit`, even when an exception occurs. Use `try/finally` or a context manager.
6. **Keep the small files small.** `run.json`, `params.yaml`, `metrics.json` and `config.json` over 16 MB are not parsed.

### 3. `run.json`

```json
{
  "schema_version": 1,
  "id": "20260929-154600_mlp-baseline_a3f1",
  "name": "mlp-baseline",
  "group": "lr-sweep",
  "tags": ["cv"],
  "notes": "",
  "status": "running",
  "started_at": "2026-09-29T13:46:00Z",
  "ended_at": null,
  "heartbeat_at": "2026-09-29T13:47:10Z",
  "duration_s": null,
  "exit": null,
  "command": ["python", "train.py", "--lr", "3e-4"],
  "cwd": "/home/u/proj",
  "host": {"hostname": "gpu01", "pid": 1234, "user": "u", "python": "3.12.3", "torch": "2.8.0", "cuda": "12.6", "gpus": ["NVIDIA A100"]},
  "git": {"sha": "…", "branch": "main", "dirty": true, "remote": "…"}
}
```

| Field | Type | Rules |
| --- | --- | --- |
| `schema_version` | int | `1`. |
| `id` | string | Same as the directory name. |
| `name` | string | Short human name, shown in bold in the table. |
| `group` | string or null | Free-form group (e.g. a sweep name). It can be used for grouping. |
| `tags` | string[] | Free-form labels. |
| `notes` | string | Free text. |
| `status` | string | `running` → `completed`, `failed` or `killed`. Never write `stale`; TraceML derives it. |
| `started_at` / `ended_at` / `heartbeat_at` | ISO-8601 UTC or null | `ended_at` is null while the run is running. |
| `duration_s` | number or null | Set when the run finishes. |
| `exit` | object or null | null while running. On finish it's `{"code": 0, "signal": null}`. For a failure, add `"error_type"`, `"error_message"` and `"traceback"` (full text; TraceML shows the tail). |
| `command`, `cwd`, `host`, `git` | optional | Shown in the run inspector. `host` and `git` may contain any keys. |

Status lifecycle: create the file with `running` → update `heartbeat_at` periodically → write the final status once. After a crash without cleanup, the run stays `running`, and TraceML shows it as **stale**.

### 4. `params.yaml`

A **flat** mapping with dot-separated keys and scalar values: numbers, strings, booleans or null. Every key becomes a table column that can be sorted, filtered and grouped on, and that appears in the comparison view.

```yaml
data.batch_size: 64
model.hidden: 128
optim.lr: 0.0003
optim.name: "adamw"
```

Nested YAML is accepted and flattened (`optim: {lr: …}` → `optim.lr`). Lists are shown as compact JSON strings. Use the same key names across runs of a project, otherwise the columns don't line up.

### 5. `config.json`

The full nested training configuration, as any JSON value. It's shown as a collapsible tree in the run inspector. This file is optional; `params.yaml` is what powers the table.

### 6. `metrics.jsonl`: the metric history

One JSON object per line, appended as training progresses:

```json
{"step": 9, "epoch": 9, "time": 1790000000.123, "train/loss": 0.41, "lr": 0.00021}
{"step": 9, "epoch": 9, "time": 1790000004.551, "val/loss": 0.38, "val/auc": 0.87}
```

- **`step`** (int, required): the **epoch-level** step and the primary x-axis. In TraceML V1, `step` normally equals `epoch`. Don't log per batch; log once or twice per epoch.
- **`epoch`** (int): the epoch number. **`time`** (float): Unix seconds.
- **Every other key is a metric.** Values must be numbers or `null`. A null is drawn as a gap. Don't write strings, lists or objects as metric values.
- **Name metrics with a prefix** so the metric picker can group them: `train/…`, `val/…`, `test/…`, `sys/…` (e.g. `sys/gpu_mem_gb`); `lr` or other names without a prefix go under *other*.
- **Rows may be sparse.** Log train and val metrics in separate rows with the same `step`.
- **Never write NaN or Infinity.** Write `null` instead. TraceML tolerates Python's `NaN` tokens, but other JSON readers don't.
- **Partial or corrupt lines:** a half-written final line is ignored until it's completed, and other corrupt lines are skipped and reported as a warning.

### 7. `metrics.json`: the derived summary

Rewrite it atomically after every logged row (or at least every epoch). The run table is built from this file, so TraceML never has to read the full history just to list runs.

```json
{
  "schema_version": 1,
  "updated_at": "2026-09-29T14:10:00Z",
  "step": 19,
  "epoch": 19,
  "last": {"train/loss": 0.21, "val/auc": 0.88, "lr": 0.000001},
  "best": {"val/auc": {"value": 0.894, "step": 14, "epoch": 14, "mode": "max"}},
  "summary": {"test/auc": 0.881}
}
```

- **`step` / `epoch`:** the latest logged step.
- **`last`:** the most recently logged value of **every** metric in `metrics.jsonl` (the value may be null).
- **`best`:** for each metric you care about, the best value so far, plus the `step` and `epoch` where it happened, and `mode`. The mode is `max` for AUC or accuracy and `min` for losses.
- **`summary`:** final or evaluation values that have no history, e.g. `test/*` after training. Numbers or strings.
- **Default columns:** the table shows every `best` and `summary` metric as a column by default. The scatter and box plots can use any `last`, `best` or `summary` number.

### 8. Checklist for an implementation

- [ ] A unique run directory `<runs folder>/<YYYYMMDD-HHMMSS>_<name>_<hex4>/` is created before training starts.
- [ ] `run.json` (status `running`), `params.yaml`, `config.json` and an empty `metrics.json` are written atomically at start.
- [ ] Each evaluation appends complete lines to `metrics.jsonl` with `step`, `epoch`, `time` and prefixed metric names, then flushes.
- [ ] `metrics.json` (`last`, `best`, `step`, `epoch`) is rewritten atomically after each log call.
- [ ] `heartbeat_at` is refreshed at least every 30 s, including during long epochs (use a background thread).
- [ ] On exit (normal, exception or Ctrl+C), `status`, `ended_at`, `duration_s` and `exit` are written, including the error type, message and traceback on failure. `summary` gets the test metrics.
- [ ] No NaN/Infinity, no per-batch rows, no in-place rewrites of `metrics.jsonl`.

### 9. Reference logger (Python standard library only)

This is a complete, tested implementation of the rules above. The same file is in the repository as `scripts/traceml_logger.py`. Copy it into your project, or give it to an agent as the specification.

```python
"""Minimal reference writer for the TraceML run format (schema_version 1). Python stdlib only.

Copy this file into a training project (or use it as the specification for your own logger).

    from traceml_logger import TraceMLRun

    with TraceMLRun("runs", "baseline", params={"optim": {"lr": 3e-4}, "model.hidden": 128},
                    group="lr-sweep", tags=["cv"], best={"val/auc": "max", "val/loss": "min"}) as run:
        for epoch in range(num_epochs):
            run.log(epoch, {"train/loss": train_loss, "lr": lr})
            run.log(epoch, {"val/loss": val_loss, "val/auc": val_auc})
        run.summary["test/auc"] = test_auc

Leaving the `with` block normally marks the run `completed`; an exception marks it `failed`
(with error type, message and traceback); Ctrl+C marks it `killed`.
"""

from __future__ import annotations

import json
import math
import os
import secrets
import socket
import sys
import threading
import time
import traceback
from datetime import datetime, timezone

SCHEMA_VERSION = 1


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _atomic_write(path: str, text: str) -> None:
    """Write to a dot-prefixed temp file, then rename: readers never see a half-written file."""
    tmp = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _yaml_scalar(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return json.dumps(str(v))


def _flatten(d: dict, prefix: str = "") -> dict:
    out: dict = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(_flatten(v, key + "."))
        elif isinstance(v, (list, tuple)):
            out[key] = json.dumps(list(v))
        else:
            out[key] = v
    return out


def _metric(v):
    """Numbers become floats; None / NaN / inf become null (a gap in the plot)."""
    if v is None:
        return None
    v = float(v)
    return v if math.isfinite(v) else None


class TraceMLRun:
    def __init__(self, runs_dir: str, name: str, params: dict | None = None, config: dict | None = None,
                 group: str | None = None, tags=(), notes: str = "", best: dict | None = None,
                 heartbeat_s: float = 15.0):
        self.t0 = time.time()
        stamp = datetime.fromtimestamp(self.t0, timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.id = f"{stamp}_{name}_{secrets.token_hex(2)}"
        self.dir = os.path.join(runs_dir, self.id)
        for sub in ("logs", "checkpoints", "artifacts"):
            os.makedirs(os.path.join(self.dir, sub), exist_ok=True)
        self.best_modes = dict(best or {})  # metric -> "max" | "min"
        self.last: dict = {}
        self.best: dict = {}
        self.summary: dict = {}
        self.step = None
        self.epoch = None
        self._lock = threading.Lock()
        self.meta = {
            "schema_version": SCHEMA_VERSION,
            "id": self.id,
            "name": name,
            "group": group,
            "tags": list(tags),
            "notes": notes,
            "status": "running",
            "started_at": _iso(self.t0),
            "ended_at": None,
            "heartbeat_at": _iso(self.t0),
            "duration_s": None,
            "exit": None,
            "command": [sys.executable, *sys.argv],
            "cwd": os.getcwd(),
            "host": {"hostname": socket.gethostname(), "pid": os.getpid(), "python": sys.version.split()[0]},
        }
        flat = _flatten(params or {})
        _atomic_write(os.path.join(self.dir, "params.yaml"), "".join(f"{k}: {_yaml_scalar(v)}\n" for k, v in flat.items()))
        _atomic_write(os.path.join(self.dir, "config.json"), json.dumps(config if config is not None else (params or {}), indent=2, default=str) + "\n")
        self._jsonl = open(os.path.join(self.dir, "metrics.jsonl"), "a", encoding="utf-8", newline="\n")
        self._write_meta()
        self._write_metrics_json()
        self._stop = threading.Event()
        threading.Thread(target=self._heartbeat, args=(heartbeat_s,), daemon=True).start()

    # -- writing ---------------------------------------------------------------

    def log(self, step: int, metrics: dict, epoch: int | None = None) -> None:
        """Append one row to metrics.jsonl (step = epoch-level step) and refresh metrics.json + heartbeat."""
        row = {"step": int(step), "epoch": int(step if epoch is None else epoch), "time": round(time.time(), 3)}
        for k, v in metrics.items():
            row[k] = _metric(v)
        with self._lock:
            self._jsonl.write(json.dumps(row) + "\n")  # one complete line per write
            self._jsonl.flush()
            self.step, self.epoch = row["step"], row["epoch"]
            for k, v in row.items():
                if k in ("step", "epoch", "time"):
                    continue
                self.last[k] = v
                mode = self.best_modes.get(k)
                if mode and v is not None:
                    b = self.best.get(k)
                    if b is None or (v > b["value"] if mode == "max" else v < b["value"]):
                        self.best[k] = {"value": v, "step": row["step"], "epoch": row["epoch"], "mode": mode}
            self._write_metrics_json()
            self.meta["heartbeat_at"] = _iso(time.time())
            self._write_meta()

    def finish(self, status: str = "completed", exc: BaseException | None = None) -> None:
        self._stop.set()
        now = time.time()
        with self._lock:
            if not self._jsonl.closed:
                self._jsonl.close()
            exit_info: dict = {"code": 0 if status == "completed" else 1, "signal": "SIGINT" if status == "killed" else None}
            if exc is not None and status == "failed":
                exit_info.update(
                    error_type=type(exc).__name__,
                    error_message=str(exc),
                    traceback="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                )
            self.summary = {k: (_metric(v) if isinstance(v, (int, float)) or v is None else v) for k, v in self.summary.items()}
            self._write_metrics_json()
            self.meta.update(status=status, ended_at=_iso(now), heartbeat_at=_iso(now), duration_s=round(now - self.t0, 3), exit=exit_info)
            self._write_meta()

    def __enter__(self) -> "TraceMLRun":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            self.finish("completed")
        elif issubclass(exc_type, KeyboardInterrupt):
            self.finish("killed", exc)
        else:
            self.finish("failed", exc)
        return False  # never swallow the exception

    # -- internals -------------------------------------------------------------

    def _write_meta(self) -> None:
        _atomic_write(os.path.join(self.dir, "run.json"), json.dumps(self.meta, indent=2) + "\n")

    def _write_metrics_json(self) -> None:
        _atomic_write(
            os.path.join(self.dir, "metrics.json"),
            json.dumps({
                "schema_version": SCHEMA_VERSION,
                "updated_at": _iso(time.time()),
                "step": self.step,
                "epoch": self.epoch,
                "last": self.last,
                "best": self.best,
                "summary": self.summary,
            }, indent=2) + "\n",
        )

    def _heartbeat(self, every: float) -> None:
        # Keeps heartbeat_at fresh during long epochs so the run is not shown as stale.
        while not self._stop.wait(every):
            with self._lock:
                if self._stop.is_set():
                    return
                self.meta["heartbeat_at"] = _iso(time.time())
                self._write_meta()
```

### Status and `stale`

`stale` is derived by TraceML; it's never written to disk. A run is stale when `status == "running"` and `now - heartbeat_at > traceml.staleAfterSeconds`. A completed, failed or killed run is never stale. If a running run has no `heartbeat_at`, it's shown as `running?`, because its staleness can't be judged. TraceML never invents a heartbeat time.

## Live refresh

- TraceML polls every `refreshIntervalSeconds`, and only while the panel is open. Each poll works like this:
  1. It lists the configured runs folders (one directory read each), so new runs appear and deleted runs disappear. Runs deleted from TraceML are skipped.
  2. It stats the core files of each **running** run and re-parses only files whose mtime or size changed.
  3. It advances the `metrics.jsonl` of the **plotted** runs by reading only the newly appended bytes. If the file shrank, it starts over from the beginning.
- **Finished runs are frozen.** Completed, failed and killed runs aren't re-checked on polls, because their files no longer change. They're checked again (by stat, re-parsed only if changed) when you press *Refresh*, open the panel or change a setting.
- **Run database.** The runs are saved in `traceml/.cache/runs.sqlite` (at most every 10 s while runs change; only changed runs are rewritten). When TraceML opens, the table is filled from it right away. Then each run's files are stat'ed once, and only changed files are parsed again. Without the database, the first scan parses every run. It's only a cache: deleting it is harmless, and a corrupt, edited or other-version file is rebuilt from the run folders. A `runs-index.json` left by 0.1.17 is read once and migrated. See [The run database](#the-run-database).
- Only changed runs are sent to the panel. Sort order, filters, selection, zoom and column choices are all kept across updates.
- Stale runs change status automatically as their heartbeat ages.
- Polling stays the reliable baseline even if a filesystem watcher is added later.

## Remote-SSH

With `"extensionKind": ["workspace"]`, the extension host, and so all filesystem access, runs on the remote machine next to the runs. Only small JSON messages cross the connection: run summaries, and downsampled series for the runs you're plotting. Nothing needs to be installed on the remote beyond the extension itself. You don't need Node, npm or Python packages there. To browse runs outside the opened folder, add an absolute path to `traceml.roots`, e.g. `"/scratch/me/project/runs"`.

## The run database

`traceml/.cache/runs.sqlite` is a small SQLite file with the runs TraceML shows (deleted runs excluded). Open it with `sqlite3`, DB Browser for SQLite, pandas (`pd.read_sql`) or give it to an agent:

| Table | Columns |
| --- | --- |
| `runs` | `key` (run directory), `id`, `name`, `group_name`, `tags` (`;`-separated), `notes`, `status` (from `run.json`), `display_status` (adds `stale`), `started_at` / `ended_at` / `heartbeat_at` (ISO-8601 UTC), `duration_s`, `step`, `epoch`, `path`, `location`, `legacy`, `warnings` |
| `config` | `run_key`, `key`, `value`: one row per config value (`params.yaml`); booleans are 1/0 |
| `metrics` | `run_key`, `metric`, `kind` (`start`, `last`, `best` or `summary`), `value`, and for `best` the `step` and `mode` |

```sql
-- the 5 runs with the best val/auc, with their learning rate
SELECT r.name, c.value AS lr, m.value AS best_auc
FROM runs r
JOIN metrics m ON m.run_key = r.key AND m.metric = 'val/auc' AND m.kind = 'best'
LEFT JOIN config c ON c.run_key = r.key AND c.key = 'optim.lr'
ORDER BY best_auc DESC LIMIT 5;
```

- The full per-epoch history is not copied; it stays in each run's `metrics.jsonl` (`path` points to the run folder). `run_cache` and `meta` are TraceML's own bookkeeping.
- The file is replaced atomically, so a reader never sees half a file. It reflects the runs as of the last save (up to 10 s old); treat it as read-only, since TraceML overwrites it.
- SQLite runs inside the extension as WebAssembly (sql.js, bundled). There is no native module, no server and nothing to install, also over Remote-SSH. If it can't be loaded, TraceML falls back to `runs-index.json`.

## Exporting the table for an agent

*Export* (in the runs toolbar) writes the rows currently shown in the table to a **CSV file**: filters, sort order, column order and Max rows applied, with the visible columns only. A bar then shows the file path, with **Copy path** and **Open** (read-only). Give that path to an agent (e.g. "read this CSV and compare the runs"), or load it with `pandas.read_csv`.

**Where:** in TraceML's cache folder, **`traceml/.cache/exports/`** inside the opened workspace folder (on the server when you use Remote-SSH, next to `traceml/runs`). Change it with the `traceml.cacheDir` setting, as a relative or absolute path. If no folder is open, TraceML uses its VS Code storage folder instead.

```
<workspace>/traceml/
├── runs/                      ← your runs (read-only for TraceML)
└── .cache/                    ← written by TraceML only
    ├── ui-state.json          ← remembered view (metrics, selection, filters, columns, charts)
    ├── runs.sqlite            ← run database: fast start + SQL queries (safe to delete)
    ├── hidden-runs.json       ← runs deleted from TraceML (folders untouched)
    ├── exports/
    │   ├── latest.csv         ← newest export: give this path to an agent
    │   └── table-20261001-102030.csv
    └── plots/
        ├── plot-val-auc-20261001-102512.png   ← saved charts (300 DPI)
        └── plot-bar-best-val-auc-20261001-102530.csv   ← saved chart data
```

Each export is saved as `table-YYYYMMDD-HHMMSS.csv` (UTC), and the newest is always also `latest.csv`, so an agent can simply read `traceml/.cache/exports/latest.csv`. Only the 20 newest timestamped exports (and the 50 newest plots) are kept. Add `traceml/.cache/` to your `.gitignore`.

**Format:** UTF-8, comma-separated, a header row and one row per run in table order (RFC 4180 quoting):

```csv
id,name,status,group,tags,path,started,duration_s,config.optim.lr,run.best.val/auc,summary.test/auc
20260929-230116_vseg_e9df,vseg,completed,sweep-a,cv;sweep,/mnt/proj/traceml/runs/20260929-230116_vseg_e9df,2026-09-29T23:01:16.000Z,3600,0.0003,0.894,0.881
```

- The first six columns are always `id`, `name`, `status`, `group`, `tags` (joined with `;`) and `path` (the run directory, so an agent can read `metrics.jsonl`, `config.json` or `run.json` for more detail).
- The other columns follow the table. Logged values are named by kind: `config.<key>` (`params.yaml`), `run.start.<metric>` / `run.last.<metric>` / `run.best.<metric>` (the metric history) and `summary.<key>` (final values). Fixed columns keep their names (`started`, `duration_s`, …). Timestamps are ISO-8601 UTC, and empty cells are missing or `null` values.
- The export is built by the extension from its own run data; the panel only says which runs and columns are shown. Run data is never modified.

## Exporting chart data

Every chart has a 🗎 button that saves the data behind it as a CSV file in `traceml/.cache/plots/`, so you can pass the chart (e.g. a bar plot) to an agent as plain text. A bar then shows the path with *Copy path* and *Open*. Columns use the same names as the table export (`config.*`, `run.best.*`, `summary.*`, …):

| Chart | CSV columns |
| --- | --- |
| Line | `run,path,step,epoch,time_s,<metric>`: every logged value of the metric for the plotted runs, full history (not downsampled), empty = `null`. With *Plot by groups*: `group,step,mean <metric>,n_runs` |
| Bar, one per run | `run,path,[group:<field>],<field>`: all filtered runs, also those beyond the 60 bars drawn |
| Bar, group mean | `group:<field>,n,mean <field>,min <field>,max <field>` |
| Scatter | `run,path,<x>,<y>,[<size>],[group:<field>]`. With *Plot by groups*: `group,n,mean <x>,std <x>,mean <y>,std <y>` |
| Box | `group:<field>,run,path,<field>`: one row per run; quartiles follow from the values |

```csv
run,path,group:config.data.dataset,run.best.val/auc
baseline,/mnt/proj/traceml/runs/20260929-105832_baseline_d710,cifar10,0.895
high-lr,/mnt/proj/traceml/runs/20260929-111332_high-lr_ad4a,cifar10,0.888
```

## Security and resource use

What the extension can and cannot do:

- **Read-only for your data.** TraceML never creates, modifies, renames or deletes anything in your runs. *Delete* only hides a run in TraceML; its folder stays as it is. The only files TraceML writes are in its cache folder (`traceml.cacheDir`, default `traceml/.cache`): `ui-state.json`, `runs.sqlite` (written to a temp file, then renamed), `runs-index.json` (only when SQLite is unavailable), `hidden-runs.json`, the CSV exports in `exports/` (newest 20 kept) and the PNG plots and plot data CSVs in `plots/` (newest 50 of each kept). File names are fixed or generated from a strict pattern, and pruning only removes files matching that pattern.
  - The run database, the run index and the deleted-runs list are validated field by field when they're read back, and they never decide where TraceML reads: run folders always come from listing the configured runs folders, with the usual symlink checks. Saved plots are checked to be PNG images before they're written.
  - Outside the cache module, the extension source uses only `stat`, `readdir`, `realpath`, `readFile` and `open(…, 'r')`. A test suite (`test/security.test.ts`) fails the build if a write, process or network API is added anywhere else. It also checks that the cache module writes only fixed file names inside the cache folder.
  - Files opened from the UI (*Files* in the inspector) are shown through a read-only `traceml-readonly:` file system, so they can't be edited or saved through TraceML.
- **Confined to your runs folders.** TraceML reads only inside the folders listed in `traceml.roots`, and it doesn't search the rest of the workspace.
  - Every read first resolves symlinks. A run directory or file whose real location is outside its runs folder is ignored and reported (`symlink points outside the run folder`).
  - *Open file* only accepts a known run plus one of six fixed file names, so a request like `../../secret` is rejected.
- **Restricted Mode:** because it never executes anything from the workspace, TraceML is declared safe for untrusted workspaces.
- **No network, no processes.** It makes no HTTP requests, contacts no service (W&B included), and never starts a child process or runs code from the run files.
- **Locked-down webview.** The UI runs in a VS Code webview under a strict Content-Security-Policy: scripts need a nonce, and there are no remote resources, CDNs or inline event handlers.
  - Values from run files (names, params, tracebacks, config) are inserted as text or HTML-escaped. They're never executed.
  - The webview can't touch the filesystem. It sends a fixed set of typed messages, and the extension validates each one.
- **Untrusted run files are handled defensively.**
  - JSON, YAML and JSONL parsing never executes anything. YAML alias expansion is capped (billion-laughs protection).
  - `run.json`, `params.yaml`, `metrics.json` and `config.json` over 16 MB are not parsed. `metrics.jsonl` is read up to `traceml.maxMetricsFileMB`.
  - A corrupt file only produces a warning on that run.
- **Filesystem load** is bounded:
  - Polling only runs while the TraceML panel is open **and visible**. Nothing is read when it's closed or in a background tab; it refreshes as soon as you switch back. The default is every 5 s. Finished runs are only re-checked on *Refresh*.
  - Each poll reads each configured runs folder once, plus the core files of the running runs in it. Unchanged files are skipped by modification time and size. On startup the run index avoids re-parsing unchanged runs.
  - On slow network filesystems (e.g. NFS on a cluster), raise `traceml.refreshIntervalSeconds` and narrow `traceml.roots`.
- **Dependencies:** at runtime only `yaml`, `uplot` and `sql.js` (SQLite compiled to WebAssembly; its `.wasm` is loaded from the extension's own `dist/` folder as bytes, never fetched), bundled into `dist/`. `npm audit` reports 0 known vulnerabilities.
- **CPU:** the extension host runs JavaScript on a single thread, so parsing never uses more than one CPU core. A thread limit wouldn't change anything. Big files are read in 8 MB chunks, and `traceml.maxMetricsFileMB` caps the total per run.
- **Supply chain:** a `.vsix` runs with the same permissions as VS Code itself, like any extension. Share it from a trusted place (e.g. your team's repository or releases). Before publishing to the Marketplace, set a real `publisher` and `repository` in `package.json`.
- **Dev-only scripts** (`scripts/`, not included in the `.vsix`): `fake_runs.py --clean` deletes its output directory. It refuses when that directory contains anything that isn't a run.

## Limitations

- Series are loaded only for selected runs, at most 30 at a time. A downsampled series is re-sent in full when it grows (the host sends at most `maxPointsPerSeries` points per series).
- If `metrics.jsonl` is rewritten in place with *exactly the same size*, TraceML doesn't notice until it grows or shrinks. Loggers only append, so this doesn't happen in practice.
- A final line with no trailing newline is treated as partial. It shows up once the newline is written.
- The logs viewer, artifact/checkpoint browser, git diff viewer, experiment grouping, filesystem watcher and adaptive polling are **not** part of V1.
- Only the configured runs folders are read. Runs nested deeper than one level, or symlinked from outside a runs folder, aren't shown.

## Fake run generator

`scripts/fake_runs.py` needs only the Python standard library: no PyTorch, CUDA, W&B, DVC or network access. It writes the **exact** TraceML format using atomic dot-file-and-rename writes, just like a real logger.

```bash
python scripts/fake_runs.py                                   # 24 runs into test-data/traceml/runs
python scripts/fake_runs.py --runs 100 --output test-data/traceml/runs
python scripts/fake_runs.py --runs 1000 --clean               # table performance
python scripts/fake_runs.py --big-run-lines 200000            # adds a run with a 200k-line metrics.jsonl
python scripts/fake_runs.py --runs 0 --live                   # only a live run, until Ctrl+C
python scripts/fake_runs.py --live --live-interval 1 --live-epochs 50   # live run that completes
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--output DIR` | `test-data/traceml/runs` | The runs directory to write into. |
| `--runs N` | `24` | How many historical runs to generate (`0` means none). |
| `--seed N` | `0` | Random seed. |
| `--clean` | off | Deletes the output directory first. It refuses if the directory contains anything that isn't a run. |
| `--big-run-lines N` | `0` | Also writes one run with about N `metrics.jsonl` lines. |
| `--live` | off | After generating, starts a live run that keeps appending metrics. |
| `--live-interval S` | `2` | Seconds between live epochs. |
| `--live-epochs N` | `0` | Stops after N epochs and marks the run `completed`. `0` means run until terminated. When the live run is stopped with Ctrl+C, it's left as `running`, so it turns `stale`. |
| `--no-partial-writes` | off | By default the live run sometimes writes half a line, pauses, then finishes it, to exercise partial-line handling. This option turns that off. |

The historical runs always start with a fixed set of special cases, followed by random parameter variants:

- `baseline`, `high-lr` and `small-model` (completed)
- `failed-run` (CUDA OOM) and `nan-loss` (failed)
- `killed-run` (killed)
- `stale-run` (running, but the heartbeat is old)
- `legacy-run` (no `run.json`, nested params)
- `future-schema` (`schema_version: 2`)
- `malformed-lines` (a broken line and a partial final line)

For the analysis views, the runs also vary in:

- `data.dataset` (`cifar10`, `cifar100`, `tiny-imagenet`), which clearly shifts the metric distributions. Try *Group by* `data.dataset` with the box view.
- `model.patch_size`, which only exists for `vit-tiny` runs, so some runs have no value for it.
- the `test/*` summary values, which are occasionally `null`.
- the non-numeric summary field `best_checkpoint`.

The live run appends to `metrics.jsonl`, rewrites `metrics.json` and updates `heartbeat_at` in `run.json` for every epoch.

## Development

You need Node.js 20 LTS (or newer) and npm on your **local machine**. Nothing is built on the training server.

```bash
node --version && npm --version
npm install
python scripts/fake_runs.py --clean          # local fixture data in test-data/traceml/runs
npm run build                                # esbuild -> dist/extension.js, dist/webview.{js,css}
npm test                                     # vitest
npm run typecheck                            # tsc --noEmit (strict)
npm run check                                # typecheck + test + build
npm run package                              # -> traceml-<version>.vsix
```

- **Debugging:** open this folder in VS Code and press **F5** (*Run TraceML (fake runs)*). This opens an Extension Development Host on `test-data/`. Then run **TraceML: Show Experiments**. Start `python scripts/fake_runs.py --runs 0 --live` in a terminal to watch a live run.
- **Previewing the webview without VS Code:** `npm run build && npm run preview -- test-data` writes `test-data/preview.html`. Open it in a browser; it uses the real host-side parsing and a mocked VS Code API. Add `#demo` to the URL to pre-select a few runs.
- **Benchmarking the host pipeline:** `npm run bench -- test-data/perf` (after `python scripts/fake_runs.py --runs 1000 --output test-data/perf/runs --big-run-lines 200000`). On a typical Windows laptop, parsing 1,000 runs takes about 0.7 s, a no-change poll takes about 20 ms, loading a 200k-line history takes about 0.4 s, and re-polling it when nothing changed takes under 1 ms.

Project layout:

```
src/extension.ts        activation, commands, webview panel, polling loop, message handling
src/discovery.ts        resolves the configured runs folders and lists the runs inside them
src/fsGuard.ts          read confinement (realpath + inside-folder checks)
src/readonlyFs.ts       read-only file system used to open run files
src/runStore.ts         parsed-run cache (mtime/size), summaries, on-demand histories and details
src/runIndex.ts         run state (de)serialization + field-by-field validation (runs-index.json fallback)
src/runDb.ts            run database (runs.sqlite via sql.js): schema, incremental updates, load
src/cacheStore.ts       the only writer: ui-state, run index, deleted runs, CSV exports, PNG plots
src/model/tableExport.ts, plotData.ts, png.ts, hiddenRuns.ts   table/chart CSV, PNG DPI stamping, deleted runs
src/poller.ts           non-overlapping interval poller
src/protocol.ts         typed host <-> webview messages + validation of webview input
src/types.ts, paths.ts  shared types; OS-independent path/glob helpers
src/parsers/*           run.json, params.yaml, config.json, metrics.json, incremental metrics.jsonl
src/model/*             status/summary, columns, sorting, filters, comparison, downsampling, EMA
src/model/analysis.ts   grouping, scatter/box data extraction, quartiles, axis ticks (pure, tested)
src/webview/*           vanilla-TS UI: shell.ts (sidebar/header/inspector host), ui.ts (icons, buttons,
                        chips, switches, popovers, empty states), filters.ts (runs toolbar), table.ts
                        (virtualized, grouped, keyed rows), plots.ts (metric toolbar + uPlot lines),
                        analysis.ts (Line|Scatter|Box, SVG scatter/box), detail.ts (inspector),
                        pngExport.ts (300 DPI chart rendering),
                        comparison.ts, overview.ts, styles/ (design tokens + CSS)
test/*                  vitest suites + fixtures
scripts/fake_runs.py    fake run generator; scripts/traceml_logger.py reference logger;
                        scripts/preview.ts, bench.ts are dev-only helpers
```

## Architecture decisions

- **No server.** There's no HTTP server, no localhost port and no background process. The UI is a VS Code webview.
- **No database server.** Parsed state is an in-memory cache rebuilt from the files. `traceml/.cache/runs.sqlite` is an SQLite file copy of that cache (with each file's mtime and size), used to start faster and for SQL queries. The run folders stay the source of truth; the file can be deleted at any time.
- **Filesystem only.** The run directories are the single source of truth.
- **The webview is embedded in VS Code** and is a pure view. It can't touch the filesystem. It asks the host for data through a typed message protocol (`src/protocol.ts`), and the host validates every incoming message. File opening only accepts a known run plus a fixed list of file names, so the webview never has arbitrary filesystem access.
- **The extension host owns all filesystem access and parsing.** With `extensionKind: ["workspace"]`, that happens on the Remote-SSH host.
- **`metrics.jsonl` is the canonical history.** It's read incrementally by byte offset, and only for runs being plotted.
- **`metrics.json` is a derived fast summary.** The table is built from `run.json`, `params.yaml` and `metrics.json` without reading `metrics.jsonl`. TraceML also reads the first 64 KB of `metrics.jsonl` (once the file is past 64 KB, never again) for each metric's starting value and, for runs without `metrics.json`, the metric names.
- **No DVC or DVCLive dependency**, and no MLflow.
- **TraceML never accesses W&B.** The training-side logger may send the same run to W&B on its own; TraceML reads only the local files.
- **`stale` is derived from the heartbeat.** It's never stored.
- **Downsampling uses min/max-preserving buckets.** The first and last points are always kept, and so are nulls inside a bucket, so gaps survive. It never takes every Nth point.
- **Development happens locally** with Node.js 20 LTS and npm. Runtime dependencies are only `yaml` and `uplot`, bundled by esbuild into `dist/`.
- **Dark-only webview UI with a token-based design system.** Everything is vanilla TypeScript and CSS: no UI framework, no CDN, and a strict CSP. Styles are split into `tokens.css`, `base.css`, `layout.css` and `components.css` under `src/webview/styles/`.
- **Scatter and box plots use run-level data only.** They are computed in the webview from the run summaries it already has (`run.json`, `params.yaml` and `metrics.json`), so changing a visualization never touches the filesystem or reads `metrics.jsonl`. They are drawn as plain SVG because uPlot is built for x-ordered time series; line plots still use uPlot.
- **Three kinds of logged values: config, run and summary.** The file format is unchanged (`params.yaml`, `metrics.jsonl` + `metrics.json` last/best, `metrics.json` summary). The UI, the Compare view and the CSV export name them the same way.
- **PNG export is rendered in the webview.** Line charts are redrawn off-screen at 300/96 scale, with fonts and lines scaled too; SVG charts are rasterized as vectors. The host checks the image, writes 300 DPI into its `pHYs` chunk, and saves it in the cache folder.
- **Grouping is computed locally** from run metadata. Nothing about grouping is stored on disk or on a server.
- **Fake runs come first.** Development and tests use `scripts/fake_runs.py` data before validating against real remote runs.

Decisions made where the spec was ambiguous:

- `exit` failure details: both the flat layout (`exit.error_type`, `exit.error_message`, `exit.traceback`) and a nested `exit.error` object are accepted.
- A running run without `heartbeat_at` is shown as `running?`.
- The run color is assigned when a run is first selected, using the least-used palette entry among the selected runs, and is kept after that.
- The metric picker lists the metrics of the selected runs, or of all runs when nothing is selected. Until you pick metrics yourself, it defaults to `train/loss`, `val/loss` and `val/auc` where they exist.
- `traceml.roots` lists folders explicitly. There's no recursive or pattern-based search, so TraceML never reads anything outside those folders.
- A plain number in a text column's filter is a substring match. In a numeric column it's an equality match.
- If a file becomes unreadable (corrupt), the last good parse is kept and a warning is shown.
- In grouping, a run's tags are joined into one label (e.g. `cv, sweep`), so each run belongs to exactly one group. Missing values form the `(none)` group.
- Group colors come from the order of the groups among the filtered runs, so they can shift when the filters change.
- A scatter point whose Size value is missing is still plotted, at the default size. Only a missing X or Y excludes it.
