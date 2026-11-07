"""Render the latest snapshot in Prometheus text format (for the external monitoring endpoint)."""
from __future__ import annotations

from typing import Any


def _esc(v: str) -> str:
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def render(snapshot: dict[str, Any] | None, names: dict[int, str]) -> str:
    if not snapshot:
        return ""
    lines: list[str] = []

    def metric(name: str, help_: str, samples: list[tuple[dict[str, str], float]]) -> None:
        if not samples:
            return
        lines.append(f"# HELP {name} {help_}")
        lines.append(f"# TYPE {name} gauge")
        for labels, value in samples:
            lab = ",".join(f'{k}="{_esc(v)}"' for k, v in labels.items())
            lines.append(f"{name}{{{lab}}} {value}" if lab else f"{name} {value}")

    s = snapshot["system"]
    metric("omm_system_cpu_percent", "System CPU usage", [({}, s["cpu_percent"])])
    metric("omm_system_memory_used_bytes", "System memory in use", [({}, s["mem_used"])])
    metric("omm_system_memory_total_bytes", "System memory total", [({}, s["mem_total"])])
    gpus = snapshot["gpu"]["devices"]
    gl = lambda g: {"gpu": str(g["index"]), "name": g["name"]}  # noqa: E731
    metric("omm_gpu_memory_used_bytes", "GPU memory in use", [(gl(g), g["mem_used"]) for g in gpus])
    metric("omm_gpu_memory_total_bytes", "GPU memory total", [(gl(g), g["mem_total"]) for g in gpus])
    metric("omm_gpu_utilization_percent", "GPU utilization", [(gl(g), g["util_percent"]) for g in gpus if g["util_percent"] is not None])

    cpu, rss, vram, up, loaded = [], [], [], [], []
    for sid, d in snapshot["instances"].items():
        lab = {"instance": names.get(int(sid), sid)}
        cpu.append((lab, d["cpu_percent"]))
        rss.append((lab, d["rss"]))
        up.append((lab, 1 if d["responsive"] else 0))
        loaded.append((lab, len(d["models"])))
        if d["vram_bytes"] is not None:
            vram.append(({**lab, "source": d["vram_source"]}, d["vram_bytes"]))
    metric("omm_instance_up", "1 if the instance API responds", up)
    metric("omm_instance_cpu_percent", "Instance CPU usage (process tree)", cpu)
    metric("omm_instance_memory_rss_bytes", "Instance resident memory (process tree)", rss)
    metric("omm_instance_vram_bytes", "Instance VRAM (source: nvml or estimated)", vram)
    metric("omm_instance_loaded_models", "Models currently loaded", loaded)
    return "\n".join(lines) + "\n"
