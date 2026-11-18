"""The tools the MCP server offers: read-only, in the same process as the app (they call the services directly, no HTTP round trip).

What is offered: the instances, the machine's readings, the models and their downloads, the logs, the request journal's numbers and the
history of the readings. What is left out on purpose: anything that changes the app (start, stop, create, delete, settings), the content of
requests (what was asked and answered: prompts and model output would reach the connected model as if they were instructions) and every
secret (an instance's API key, the tokens). The control tools (start, stop, restart an instance) are only registered when the "control" setting
is on, which it is not by default; a client that was connected before the switch is changed sees the new tool list at its next session.
"""
from __future__ import annotations

import functools
from typing import Any, Awaitable, Callable

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from app.services.instances import InstanceError, InstanceManager
from app.services.models import ModelService
from app.services.monitor.collector import Collector

# the most one call may return: a model reads what comes back, and a long list costs it more than it tells
MAX_LOG_LINES = 300
MAX_REQUESTS = 50
MAX_HISTORY = 240

MAX_DRAIN_SECONDS = 120

_BASE_INSTRUCTIONS = (
    "View of the Ollama Multi Manager desktop app: its Ollama instances, the machine's CPU/RAM/GPU readings, installed models "
    "and downloads, logs, and request statistics. Request contents (prompts and answers) are not offered."
)


def instructions(control: bool = False) -> str:
    """What the server tells a client about itself: read-only, unless the control tools are switched on."""
    if control:
        return (_BASE_INSTRUCTIONS + " The reading tools change nothing. start_instance, stop_instance and restart_instance do change the app: "
                "they act on the instances the user has set up, and stopping or restarting one interrupts what it is answering unless drain_seconds "
                "gives it time to finish. Use them only when the user asked for it.")
    return _BASE_INSTRUCTIONS + " Nothing here changes the app."


INSTRUCTIONS = instructions(False)

READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
START = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)
STOP = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False)


def masked(instance: dict[str, Any]) -> dict[str, Any]:
    """An instance as the tools show it: the API key is never part of it (only whether there is one)."""
    options = dict(instance.get("options") or {})
    if options.get("api_key"):
        options["api_key"] = "********"
    return {**instance, "options": options}


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(int(value), high))


def _failing(job: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """The app's own errors (an instance that does not exist ...) become a tool error whose message the model can read (an error the SDK
        does not know is a crash, and the model is told only that the tool failed)."""
    @functools.wraps(job)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await job(*args, **kwargs)
        except InstanceError as e:
            raise ToolError(e.message) from e
    return wrapper


def register_tools(server: MCPServer, manager: InstanceManager, collector: Collector, models: ModelService) -> None:
    def tool(job: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        return server.tool(annotations=READ_ONLY)(_failing(job))

    @tool
    async def list_instances() -> list[dict[str, Any]]:
        """All Ollama instances this app manages: name, port, state (running, stopped ...), options such as the context length and the
        compute device, and the models loaded. API keys are hidden."""
        return [masked(i) for i in manager.list()]

    @tool
    async def get_instance(instance_id: int) -> dict[str, Any]:
        """One instance in full (same fields as list_instances)."""
        return masked(manager.get(instance_id))

    @tool
    async def get_system_status() -> dict[str, Any]:
        """The latest readings, taken every few seconds: CPU, RAM and disk, each GPU (name, utilisation, memory, temperature, whether the
        memory is shared with the CPU), and per running instance its CPU, memory, GPU memory and the models loaded."""
        snapshot = collector.latest
        if snapshot is None:
            raise ToolError("No readings have been collected yet; try again in a few seconds")
        return snapshot

    @tool
    async def get_system_history(last: int = 60) -> list[dict[str, Any]]:
        """The machine's CPU and memory readings over time (oldest first), as many of the newest as asked for (at most 240)."""
        return list(collector.history)[-clamp(last, 1, MAX_HISTORY):]

    @tool
    async def get_instance_history(instance_id: int, last: int = 60) -> list[dict[str, Any]]:
        """One running instance's readings over time (CPU as a share of the machine, memory, GPU memory, requests being processed and
        queued), oldest first, at most 240. Empty for an instance that is not running."""
        manager.get(instance_id)  # an instance that does not exist is an error, not an empty list
        return list(collector.inst_history.get(instance_id, []))[-clamp(last, 1, MAX_HISTORY):]

    @tool
    async def list_models() -> list[dict[str, Any]]:
        """The models installed on this machine (name, size, family, parameters, quantisation, when modified). Reading the list starts
        the app's model store server if it is not running."""
        return await models.list()

    @tool
    async def get_model(name: str) -> dict[str, Any]:
        """One installed model in detail, as `ollama show` gives it (parameters, template, licence ...)."""
        return await models.show(name)

    @tool
    async def list_downloads() -> list[dict[str, Any]]:
        """Model downloads: running, paused, failed or finished, with their progress."""
        return models.list_tasks()

    @tool
    async def get_logs(instance_id: int | None = None, limit: int = 100) -> list[dict[str, Any]]:
        """The newest log lines (oldest first), at most 300: of one instance, or of the app and all instances together when no instance
        is named. Each line has its time, the source, the level and the text."""
        return manager.recent_logs(instance_id, clamp(limit, 1, MAX_LOG_LINES))

    @tool
    async def get_requests(instance_id: int, limit: int = 20) -> dict[str, Any]:
        """The newest requests an instance relayed (time, path, model, status, duration, tokens, client), at most 50, and the numbers per
        model over the last 5 minutes. What was asked and answered is not part of it."""
        return manager.requests(instance_id, clamp(limit, 1, MAX_REQUESTS))


def register_control_tools(server: MCPServer, manager: InstanceManager) -> None:
    """The tools that change something. Registered only when the user switched the control setting on."""
    def tool(annotations: ToolAnnotations) -> Callable[[Callable[..., Awaitable[Any]]], Callable[..., Awaitable[Any]]]:
        return lambda job: server.tool(annotations=annotations)(_failing(job))

    @tool(START)
    async def start_instance(instance_id: int) -> dict[str, Any]:
        """Start a stopped instance and return it (the state shows `starting` or `running`). An instance that is already running is an error."""
        return masked(await manager.start(instance_id))

    @tool(STOP)
    async def stop_instance(instance_id: int, drain_seconds: int = 0) -> dict[str, Any]:
        """Stop an instance (it stays stopped after an app restart). Requests it is answering are cut off, unless drain_seconds (at most 120)
        gives them that long to finish first. Stopping an instance that is not running is not an error."""
        return masked(await manager.stop(instance_id, drain=clamp(drain_seconds, 0, MAX_DRAIN_SECONDS)))

    @tool(STOP)
    async def restart_instance(instance_id: int, drain_seconds: int = 0) -> dict[str, Any]:
        """Stop an instance and start it again (to apply changed options, or to free its memory). Requests it is answering are cut off, unless
        drain_seconds (at most 120) gives them that long to finish first."""
        return masked(await manager.restart(instance_id, drain=clamp(drain_seconds, 0, MAX_DRAIN_SECONDS)))
