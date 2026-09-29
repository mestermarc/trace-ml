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
