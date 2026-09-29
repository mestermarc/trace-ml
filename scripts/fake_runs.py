#!/usr/bin/env python3
"""Generate fake TraceML runs for developing and testing the TraceML VS Code extension.

Standard library only. Produces the exact TraceML filesystem format:

    <output>/<run_id>/
        run.json  params.yaml  config.json  metrics.jsonl  metrics.json
        logs/run.log  checkpoints/  artifacts/  [manifest.json] [split.json] [git.diff]

Examples:

    python scripts/fake_runs.py                                  # 24 runs into test-data/runs
    python scripts/fake_runs.py --runs 1000 --clean              # table performance
    python scripts/fake_runs.py --big-run-lines 200000           # adds a 200k-line metrics.jsonl
    python scripts/fake_runs.py --runs 0 --live                  # only a live run, until Ctrl+C
    python scripts/fake_runs.py --live --live-interval 1 --live-epochs 50
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import signal
import sys
import time
from datetime import datetime, timezone

SCHEMA_VERSION = 1

GROUPS = ["lr-sweep", "arch-sweep", "regularization", "baseline"]
TAGS = [["cv"], ["cv", "sweep"], ["ablation"], [], ["cv", "long"]]
HOSTS = ["gpu01", "gpu02", "gpu03", "gpu04"]


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def atomic_write_text(path: str, text: str) -> None:
    """Write via a dot-prefixed temp file + rename, exactly like the real logger.

    TraceML ignores files starting with '.', so readers never see half-written files.
    """
    d = os.path.dirname(path)
    tmp = os.path.join(d, f".{os.path.basename(path)}.tmp-{os.getpid()}")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            # Windows: the target may be briefly open by a reader.
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def write_json(path: str, obj) -> None:
    atomic_write_text(path, json.dumps(obj, indent=2) + "\n")


def yaml_scalar(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return json.dumps(str(v))


def flat_params_yaml(params: dict) -> str:
    return "".join(f"{k}: {yaml_scalar(v)}\n" for k, v in params.items())


def nested_params_yaml(nested: dict, indent: int = 0) -> str:
    out = []
    for k, v in nested.items():
        if isinstance(v, dict):
            out.append(" " * indent + f"{k}:\n" + nested_params_yaml(v, indent + 2))
        else:
            out.append(" " * indent + f"{k}: {yaml_scalar(v)}\n")
    return "".join(out)


def nest(flat: dict) -> dict:
    root: dict = {}
    for key, value in flat.items():
        node = root
        parts = key.split(".")
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = value
    return root


def metric_line(row: dict) -> str:
    return json.dumps(row, separators=(", ", ": ")) + "\n"


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------


def sample_params(rng: random.Random, overrides: dict | None = None) -> dict:
    p = {
        "data.dataset": rng.choice(["cifar10", "cifar10", "cifar100", "tiny-imagenet"]),
        "data.batch_size": rng.choice([32, 64, 128]),
        "data.augment": rng.choice([True, False]),
        "model.name": rng.choice(["mlp", "resnet18", "vit-tiny"]),
        "model.hidden": rng.choice([64, 128, 256, 512]),
        "model.dropout": rng.choice([0.0, 0.1, 0.3]),
        "optim.name": rng.choice(["adamw", "sgd"]),
        "optim.lr": rng.choice([1e-4, 3e-4, 1e-3, 3e-3]),
        "optim.weight_decay": rng.choice([0.0, 0.01]),
        "train.epochs": rng.choice([10, 20, 30, 40, 60]),
        "train.seed": rng.randint(0, 9999),
    }
    if overrides:
        p.update(overrides)
    # a parameter that only exists for some runs (tests missing values in grouping/scatter)
    if p["model.name"] == "vit-tiny":
        p["model.patch_size"] = rng.choice([4, 8])
    return p


def make_config(params: dict) -> dict:
    cfg = nest(params)
    cfg["data"].update(
        {
            "root": "/data/datasets/cifar-like",
            "num_workers": 8,
            "transforms": {"train": ["random_crop", "hflip", "normalize"], "eval": ["normalize"]},
        }
    )
    cfg["model"].update({"activation": "gelu", "layers": [params["model.hidden"]] * 3, "init": {"scheme": "kaiming", "gain": 1.0}})
    cfg["optim"].update({"betas": [0.9, 0.999], "scheduler": {"name": "cosine", "warmup_epochs": 2}})
    cfg["train"].update({"amp": True, "grad_clip": 1.0, "checkpoint": {"every": 5, "keep_best": True, "monitor": "val/auc"}})
    cfg["logging"] = {"wandb": {"enabled": False, "project": "demo"}, "log_every": 1}
    return cfg


class Simulator:
    """Produces plausible epoch-level metrics driven by the hyper-parameters."""

    def __init__(self, params: dict, rng: random.Random):
        self.p = params
        self.rng = rng
        lr = params["optim.lr"]
        # quality peaks around lr=3e-4 and larger models, with some randomness
        lr_pen = abs(math.log10(lr) - math.log10(3e-4)) * 0.05
        size_bonus = {64: 0.0, 128: 0.015, 256: 0.03, 512: 0.035}[params["model.hidden"]]
        arch_bonus = {"mlp": 0.0, "resnet18": 0.03, "vit-tiny": 0.02}[params["model.name"]]
        # harder datasets shift the whole distribution (visible in box plots grouped by dataset)
        data_pen = {"cifar10": 0.0, "cifar100": 0.07, "tiny-imagenet": 0.12}[params.get("data.dataset", "cifar10")]
        self.auc_max = min(0.975, 0.86 + size_bonus + arch_bonus - lr_pen - data_pen + rng.uniform(-0.02, 0.02))
        self.rate = 0.08 + lr * 120 + rng.uniform(0, 0.05)
        self.loss_floor = 0.08 + (0.97 - self.auc_max) * 1.5
        self.overfit = (0.3 - params["model.dropout"]) * 0.004 + (0.002 if params["model.hidden"] >= 256 else 0.0)
        self.unstable = lr >= 3e-3
        self.epochs = params["train.epochs"]
        self.epoch_s = {"mlp": 18.0, "resnet18": 55.0, "vit-tiny": 80.0}[params["model.name"]] * (64 / params["data.batch_size"]) ** 0.3
        self.steps_per_epoch = 50000 // params["data.batch_size"]

    def lr_at(self, epoch: int) -> float:
        lr = self.p["optim.lr"]
        warm = 2
        if epoch < warm:
            return lr * (epoch + 1) / warm
        t = (epoch - warm) / max(1, self.epochs - warm)
        return 0.5 * lr * (1 + math.cos(math.pi * min(1.0, t)))

    def rows(self, epoch: int, t_start: float) -> tuple[dict, dict]:
        r = self.rng
        prog = 1 - math.exp(-self.rate * (epoch + 1))
        noise = (0.06 if self.unstable else 0.015) * r.gauss(0, 1)
        train_loss = self.loss_floor + (2.3 - self.loss_floor) * (1 - prog) + abs(noise) * 0.5
        over = self.overfit * max(0, epoch - 8) ** 1.3
        val_loss = train_loss * 1.08 + over + 0.02 * r.gauss(0, 1)
        val_auc = 0.5 + (self.auc_max - 0.5) * prog - over * 0.4 + 0.006 * r.gauss(0, 1)
        val_acc = val_auc - 0.07 + 0.008 * r.gauss(0, 1)
        t_train = t_start + self.epoch_s * (epoch + 0.85) * r.uniform(0.97, 1.03)
        t_val = t_start + self.epoch_s * (epoch + 1)
        train = {
            "step": epoch,
            "epoch": epoch,
            "time": round(t_train, 3),
            "train/loss": round(max(0.01, train_loss), 5),
            "train/acc": round(min(0.999, 0.25 + 0.7 * prog + 0.01 * r.gauss(0, 1)), 5),
            "train/grad_norm": round(abs(1.5 * (1 - prog) + 0.3 + 0.2 * r.gauss(0, 1)), 4),
            "lr": float(f"{self.lr_at(epoch):.6g}"),
            "sys/gpu_mem_gb": round(4 + self.p["model.hidden"] / 64 + r.uniform(-0.1, 0.1), 2),
        }
        val = {
            "step": epoch,
            "epoch": epoch,
            "time": round(t_val, 3),
            "val/loss": round(max(0.01, val_loss), 5),
            # occasionally undefined (e.g. single-class eval batch) -> null is a gap
            "val/auc": None if r.random() < 0.02 else round(min(0.999, max(0.4, val_auc)), 5),
            "val/acc": round(min(0.999, max(0.1, val_acc)), 5),
        }
        return train, val


class MetricsTracker:
    """Maintains the derived metrics.json summary (last / best / summary)."""

    BEST_MODES = {"val/auc": "max", "val/acc": "max", "val/loss": "min"}

    def __init__(self):
        self.last: dict = {}
        self.best: dict = {}
        self.summary: dict = {}
        self.step = None
        self.epoch = None

    def update(self, row: dict) -> None:
        self.step = row.get("step", self.step)
        self.epoch = row.get("epoch", self.epoch)
        for k, v in row.items():
            if k in ("step", "epoch", "time"):
                continue
            self.last[k] = v
            mode = self.BEST_MODES.get(k)
            if mode and v is not None:
                cur = self.best.get(k)
                better = cur is None or (v > cur["value"] if mode == "max" else v < cur["value"])
                if better:
                    self.best[k] = {"value": v, "step": row.get("step"), "epoch": row.get("epoch"), "mode": mode}

    def to_json(self, now: float, schema_version: int = SCHEMA_VERSION) -> dict:
        return {
            "schema_version": schema_version,
            "updated_at": iso(now),
            "step": self.step,
            "epoch": self.epoch,
            "last": dict(self.last),
            "best": {k: dict(v) for k, v in self.best.items()},
            "summary": dict(self.summary),
        }


# ---------------------------------------------------------------------------
# Run writer
# ---------------------------------------------------------------------------

TRACEBACKS = {
    "RuntimeError": (
        "CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 39.59 GiB total capacity)",
        [
            ('  File "/home/u/proj/train.py", line 212, in <module>', "    main()"),
            ('  File "/home/u/proj/train.py", line 188, in main', "    loss = trainer.fit_epoch(epoch)"),
            ('  File "/home/u/proj/trainer.py", line 97, in fit_epoch', "    out = self.model(x)"),
            ('  File "/home/u/.venv/lib/python3.12/site-packages/torch/nn/modules/module.py", line 1751, in _wrapped_call_impl', "    return self._call_impl(*args, **kwargs)"),
        ],
    ),
    "ValueError": (
        "Loss is NaN at epoch {epoch}; aborting (check learning rate)",
        [
            ('  File "/home/u/proj/train.py", line 212, in <module>', "    main()"),
            ('  File "/home/u/proj/train.py", line 190, in main', "    trainer.check_finite(loss)"),
            ('  File "/home/u/proj/trainer.py", line 141, in check_finite', "    raise ValueError(msg)"),
        ],
    ),
}


def make_traceback(error_type: str, message: str) -> str:
    frames = TRACEBACKS[error_type][1]
    lines = ["Traceback (most recent call last):"]
    for a, b in frames:
        lines += [a, b]
    lines.append(f"{error_type}: {message}")
    return "\n".join(lines)


def run_id_for(name: str, started: float, rng: random.Random) -> str:
    stamp = datetime.fromtimestamp(started, tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{stamp}_{name}_{rng.getrandbits(16):04x}"


def base_run_json(run_id: str, name: str, group: str, tags: list, params: dict, started: float, rng: random.Random) -> dict:
    cmd = ["python", "train.py", "--config", "configs/base.yaml", "--lr", str(params["optim.lr"]), "--model", params["model.name"]]
    return {
        "schema_version": SCHEMA_VERSION,
        "id": run_id,
        "name": name,
        "group": group,
        "tags": tags,
        "notes": "",
        "status": "running",
        "started_at": iso(started),
        "ended_at": None,
        "heartbeat_at": iso(started),
        "duration_s": None,
        "exit": None,
        "command": cmd,
        "cwd": "/home/u/proj",
        "host": {
            "hostname": rng.choice(HOSTS),
            "pid": rng.randint(1000, 99999),
            "user": "u",
            "python": "3.12.3",
            "torch": "2.8.0",
            "cuda": "12.6",
            "gpus": ["NVIDIA A100-SXM4-40GB"],
        },
        "git": {
            "sha": "%040x" % rng.getrandbits(160),
            "branch": rng.choice(["main", "main", "feat/augment"]),
            "dirty": rng.random() < 0.3,
            "remote": "git@github.com:example/proj.git",
        },
    }


class RunSpec:
    def __init__(self, name, *, group=None, tags=None, outcome="completed", params=None, fail_type="RuntimeError",
                 legacy=False, schema_version=SCHEMA_VERSION, malformed=False, big_lines=0):
        self.name = name
        self.group = group
        self.tags = tags
        self.outcome = outcome  # completed | failed | killed | stale
        self.params = params or {}
        self.fail_type = fail_type
        self.legacy = legacy
        self.schema_version = schema_version
        self.malformed = malformed
        self.big_lines = big_lines


def ensure_run_dirs(run_dir: str) -> None:
    for sub in ("logs", "checkpoints", "artifacts"):
        os.makedirs(os.path.join(run_dir, sub), exist_ok=True)


def write_run(out_dir: str, spec: RunSpec, started: float, rng: random.Random, now: float) -> str:
    params = sample_params(rng, spec.params)
    group = spec.group or rng.choice(GROUPS)
    tags = spec.tags if spec.tags is not None else rng.choice(TAGS)
    sim = Simulator(params, rng)

    epochs = sim.epochs
    if spec.big_lines:
        epochs = spec.big_lines // 2
        sim.epoch_s = 36000.0 / epochs  # squeeze the whole history into ~10h so it ends in the past
    end_epoch = epochs
    if spec.outcome == "failed":
        end_epoch = rng.randint(2, max(3, epochs // 2))
    elif spec.outcome == "killed":
        end_epoch = rng.randint(3, max(4, epochs - 2))
    elif spec.outcome == "stale":
        end_epoch = rng.randint(3, max(4, epochs - 2))

    run_id = run_id_for(spec.name, started, rng)
    run_dir = os.path.join(out_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    ensure_run_dirs(run_dir)

    tracker = MetricsTracker()
    log_lines = [f"{iso(started)} INFO starting run {run_id} on {HOSTS[0]}", f"{iso(started)} INFO params: {json.dumps(params)}"]
    last_time = started
    with open(os.path.join(run_dir, "metrics.jsonl"), "w", encoding="utf-8", newline="\n") as f:
        for epoch in range(end_epoch):
            train, val = sim.rows(epoch, started)
            for row in (train, val):
                f.write(metric_line(row))
                tracker.update(row)
            last_time = val["time"]
            if spec.malformed and epoch == 3:
                f.write('{"step": 3, "epoch": 3, "time": oops this line is broken\n')
            if not spec.big_lines or epoch % 1000 == 0:
                log_lines.append(
                    f"{iso(val['time'])} INFO epoch {epoch} train/loss={train['train/loss']:.4f} "
                    f"val/loss={val['val/loss']:.4f} val/auc={val['val/auc']}"
                )
        if spec.malformed:
            # partial trailing line: must be ignored (and retried) by readers
            f.write('{"step": 999, "epoch": 999, "time": 1790000000.0, "train/lo')

    ended = last_time + 5.0
    status = "completed"
    exit_info = None
    if spec.outcome == "completed":
        test_auc = (tracker.best.get("val/auc") or {"value": 0.8})["value"] - rng.uniform(0.003, 0.015)
        tracker.summary = {
            "test/auc": round(test_auc, 5),
            "test/acc": round(test_auc - 0.07, 5),
            "test/loss": round((tracker.last.get("val/loss") or 0.5) * rng.uniform(0.98, 1.05), 5),
            "val/auc_best": (tracker.best.get("val/auc") or {}).get("value"),
            "val/loss_best": (tracker.best.get("val/loss") or {}).get("value"),
            "train/wall_s": round(ended - started, 1),
            "best_checkpoint": "checkpoints/best.pt",  # non-numeric summary value
        }
        if rng.random() < 0.06:
            # test evaluation skipped: null summary values must not break sorting/plots
            tracker.summary["test/auc"] = None
            tracker.summary["test/acc"] = None
        exit_info = {"code": 0, "signal": None}
        log_lines.append(f"{iso(ended)} INFO training complete; test/auc={tracker.summary['test/auc']}")
    elif spec.outcome == "failed":
        status = "failed"
        message = TRACEBACKS[spec.fail_type][0].format(epoch=end_epoch)
        tb = make_traceback(spec.fail_type, message)
        exit_info = {"code": 1, "signal": None, "error_type": spec.fail_type, "error_message": message, "traceback": tb}
        log_lines.append(f"{iso(ended)} ERROR run failed")
        log_lines += tb.splitlines()
    elif spec.outcome == "killed":
        status = "killed"
        exit_info = {"code": -15, "signal": "SIGTERM"}
        log_lines.append(f"{iso(ended)} WARNING received SIGTERM, shutting down")
    elif spec.outcome == "stale":
        status = "running"  # process died without updating run.json -> TraceML derives "stale"

    rj = base_run_json(run_id, spec.name, group, tags, params, started, rng)
    rj["schema_version"] = spec.schema_version
    rj["status"] = status
    rj["heartbeat_at"] = iso(last_time)
    if status != "running":
        rj["ended_at"] = iso(ended)
        rj["duration_s"] = round(ended - started, 3)
        rj["exit"] = exit_info
    if spec.schema_version > SCHEMA_VERSION:
        rj["resources"] = {"note": "field from a future schema version"}

    if spec.legacy:
        # legacy runs: no run.json, nested params.yaml
        atomic_write_text(os.path.join(run_dir, "params.yaml"), nested_params_yaml(nest(params)))
    else:
        write_json(os.path.join(run_dir, "run.json"), rj)
        atomic_write_text(os.path.join(run_dir, "params.yaml"), flat_params_yaml(params))
    write_json(os.path.join(run_dir, "config.json"), make_config(params))
    write_json(os.path.join(run_dir, "metrics.json"), tracker.to_json(last_time, spec.schema_version))
    with open(os.path.join(run_dir, "logs", "run.log"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(log_lines) + "\n")

    if status in ("completed", "killed"):
        for ck in ("last.pt", "best.pt"):
            with open(os.path.join(run_dir, "checkpoints", ck), "wb") as f:
                f.write(b"\x00" * 64)
    write_json(os.path.join(run_dir, "artifacts", "class_names.json"), ["cat", "dog", "bird", "car"])
    if rng.random() < 0.6:
        write_json(os.path.join(run_dir, "split.json"), {"train": 45000, "val": 5000, "test": 10000, "seed": params["train.seed"]})
    if rng.random() < 0.5:
        files = sorted(
            os.path.relpath(os.path.join(dp, fn), run_dir).replace(os.sep, "/")
            for dp, _, fns in os.walk(run_dir)
            for fn in fns
        )
        write_json(os.path.join(run_dir, "manifest.json"), {"schema_version": 1, "files": files})
    if rj["git"]["dirty"]:
        atomic_write_text(
            os.path.join(run_dir, "git.diff"),
            "diff --git a/train.py b/train.py\n--- a/train.py\n+++ b/train.py\n@@ -10,3 +10,3 @@\n-LR = 1e-3\n+LR = 3e-4\n",
        )
    return run_dir


# ---------------------------------------------------------------------------
# Live run
# ---------------------------------------------------------------------------


def live_run(out_dir: str, rng: random.Random, interval: float, max_epochs: int, partial_writes: bool) -> None:
    params = sample_params(rng, {"train.epochs": max_epochs if max_epochs > 0 else 200})
    sim = Simulator(params, rng)
    started = time.time()
    run_id = run_id_for("live-run", started, rng)
    run_dir = os.path.join(out_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    ensure_run_dirs(run_dir)

    rj = base_run_json(run_id, "live-run", "live", ["live"], params, started, rng)
    write_json(os.path.join(run_dir, "run.json"), rj)
    atomic_write_text(os.path.join(run_dir, "params.yaml"), flat_params_yaml(params))
    write_json(os.path.join(run_dir, "config.json"), make_config(params))
    tracker = MetricsTracker()
    write_json(os.path.join(run_dir, "metrics.json"), tracker.to_json(started))
    open(os.path.join(run_dir, "metrics.jsonl"), "w").close()
    log_path = os.path.join(run_dir, "logs", "run.log")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(f"{iso(started)} INFO starting live run {run_id}\n")

    print(f"live run: {run_dir}")
    print(f"appending one epoch every {interval}s; Ctrl+C to stop (the run is then left 'running' and turns stale)")

    stop = {"flag": False}

    def _term(signum, frame):
        stop["flag"] = True

    signal.signal(signal.SIGINT, _term)
    try:
        signal.signal(signal.SIGTERM, _term)
    except (AttributeError, ValueError):
        pass

    # Drive the simulator on a compressed clock: one fake epoch per `interval` of real time.
    sim.epoch_s = interval
    epoch = 0
    try:
        while not stop["flag"] and (max_epochs <= 0 or epoch < max_epochs):
            time.sleep(interval)
            train, val = sim.rows(epoch, started)
            now = time.time()
            train["time"] = round(now - 0.1, 3)
            val["time"] = round(now, 3)
            with open(os.path.join(run_dir, "metrics.jsonl"), "a", encoding="utf-8", newline="\n") as f:
                line = metric_line(train)
                if partial_writes and epoch % 3 == 1:
                    # write half a line, flush, pause: readers must tolerate a partial final line
                    cut = len(line) // 2
                    f.write(line[:cut])
                    f.flush()
                    time.sleep(min(0.8, interval / 2))
                    f.write(line[cut:])
                else:
                    f.write(line)
                f.write(metric_line(val))
            tracker.update(train)
            tracker.update(val)
            write_json(os.path.join(run_dir, "metrics.json"), tracker.to_json(now))
            rj["heartbeat_at"] = iso(now)
            write_json(os.path.join(run_dir, "run.json"), rj)
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"{iso(now)} INFO epoch {epoch} train/loss={train['train/loss']:.4f} val/auc={val['val/auc']}\n")
            print(f"  epoch {epoch}: train/loss={train['train/loss']:.4f} val/auc={val['val/auc']}", flush=True)
            epoch += 1
    finally:
        if max_epochs > 0 and epoch >= max_epochs:
            now = time.time()
            tracker.summary = {"val/auc_best": (tracker.best.get("val/auc") or {}).get("value")}
            write_json(os.path.join(run_dir, "metrics.json"), tracker.to_json(now))
            rj.update(status="completed", ended_at=iso(now), heartbeat_at=iso(now), duration_s=round(now - started, 3), exit={"code": 0, "signal": None})
            write_json(os.path.join(run_dir, "run.json"), rj)
            print("live run completed")
        else:
            print("stopped; run.json left as 'running' (TraceML will mark it stale after staleAfterSeconds)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def looks_like_run_dir(path: str) -> bool:
    return any(os.path.exists(os.path.join(path, f)) for f in ("run.json", "metrics.json", "metrics.jsonl", "params.yaml", "config.json"))


def clean_output(out_dir: str) -> None:
    if not os.path.isdir(out_dir):
        return
    for entry in os.listdir(out_dir):
        p = os.path.join(out_dir, entry)
        if os.path.isdir(p) and not looks_like_run_dir(p):
            sys.exit(f"refusing to --clean {out_dir}: {entry!r} does not look like a run directory")
        if os.path.isfile(p) and not entry.startswith("."):
            sys.exit(f"refusing to --clean {out_dir}: unexpected file {entry!r}")
    shutil.rmtree(out_dir)


def special_specs() -> list[RunSpec]:
    return [
        RunSpec("baseline", group="baseline", tags=["cv", "baseline"], params={"optim.lr": 3e-4, "model.hidden": 256, "model.name": "resnet18", "train.epochs": 30}),
        RunSpec("high-lr", group="lr-sweep", tags=["cv"], params={"optim.lr": 3e-3, "model.hidden": 256, "model.name": "resnet18", "train.epochs": 30}),
        RunSpec("small-model", group="arch-sweep", tags=["cv"], params={"model.hidden": 64, "model.name": "mlp", "train.epochs": 40}),
        RunSpec("failed-run", group="lr-sweep", outcome="failed", fail_type="RuntimeError", params={"optim.lr": 1e-3, "train.epochs": 30}),
        RunSpec("nan-loss", group="lr-sweep", outcome="failed", fail_type="ValueError", params={"optim.lr": 3e-3, "train.epochs": 30}),
        RunSpec("killed-run", group="regularization", outcome="killed", params={"train.epochs": 40}),
        RunSpec("stale-run", group="regularization", outcome="stale", params={"train.epochs": 40}),
        RunSpec("legacy-run", group=None, legacy=True, params={"train.epochs": 20}),
        RunSpec("future-schema", group="baseline", schema_version=2, params={"train.epochs": 15}),
        RunSpec("malformed-lines", group="baseline", malformed=True, params={"train.epochs": 15}),
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate fake TraceML runs (standard library only).")
    ap.add_argument("--output", default="test-data/runs", help="runs directory to write into (default: test-data/runs)")
    ap.add_argument("--runs", type=int, default=24, help="number of historical runs to generate (default: 24; 0 = none)")
    ap.add_argument("--seed", type=int, default=0, help="random seed (default: 0)")
    ap.add_argument("--clean", action="store_true", help="delete the output directory first (only if it contains only runs)")
    ap.add_argument("--big-run-lines", type=int, default=0, help="also write one run with ~N metrics.jsonl lines (e.g. 200000)")
    ap.add_argument("--live", action="store_true", help="after generating, start a live run that appends metrics until terminated")
    ap.add_argument("--live-interval", type=float, default=2.0, help="seconds between live epochs (default: 2)")
    ap.add_argument("--live-epochs", type=int, default=0, help="stop the live run after N epochs and mark it completed (default: 0 = forever)")
    ap.add_argument("--no-partial-writes", action="store_true", help="live run: never pause mid-line")
    args = ap.parse_args()

    out_dir = os.path.abspath(args.output)
    if args.clean:
        clean_output(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    rng = random.Random(args.seed)
    now = time.time()
    specs: list[RunSpec] = []
    if args.runs > 0:
        specials = special_specs()
        specs = specials[: args.runs]
        for i in range(max(0, args.runs - len(specials))):
            outcome = rng.choices(["completed", "failed", "killed"], weights=[88, 8, 4])[0]
            specs.append(RunSpec(f"{rng.choice(['sweep', 'trial', 'exp'])}-{i:04d}", outcome=outcome))
    if args.big_run_lines > 0:
        specs.append(RunSpec("big-history", group="perf", tags=["perf"], big_lines=args.big_run_lines, params={"train.epochs": 10}))

    # Lay the runs out back to back in the past, most recent ending ~1h ago.
    spacing = 15 * 60
    started = now - 3600 - spacing * len(specs) - 24 * 3600
    for spec in specs:
        run_dir = write_run(out_dir, spec, started, rng, now)
        print(f"wrote {os.path.relpath(run_dir)}  [{spec.outcome}{', legacy' if spec.legacy else ''}]")
        started += spacing

    if args.live:
        live_run(out_dir, rng, args.live_interval, args.live_epochs, not args.no_partial_writes)


if __name__ == "__main__":
    main()
