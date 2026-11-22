"""The tools the MCP server offers: read-only, in the same process as the app (they call the services directly, no HTTP round trip).

What is offered: the instances, the machine's readings, the models and their downloads, the logs, the request journal's numbers and the
history of the readings. What is left out on purpose: anything that changes the app (start, stop, create, delete, settings), the content of
requests (what was asked and answered: prompts and model output would reach the connected model as if they were instructions) and every
secret (an instance's API key, the tokens). The control tools (start, stop, restart an instance) are only registered when the "control" setting
is on, which it is not by default; a client that was connected before the switch is changed sees the new tool list at its next session.
"""
from __future__ import annotations

import functools
from typing import Any, Awaitable, Callable, Literal

from mcp.server.mcpserver import Image, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from app.services.instances import InstanceError, InstanceManager
from app.services.models import ModelService
from app.services.monitor.collector import Collector
from app.services.shot_bridge import ShotBridge, ShotError

# the most one call may return: a model reads what comes back, and a long list costs it more than it tells
MAX_LOG_LINES = 300
MAX_REQUESTS = 50
MAX_HISTORY = 240

MAX_DRAIN_SECONDS = 120
DEFAULT_MAX_SIDE = 1568  # the longer side of the picture handed to the client

_BASE_INSTRUCTIONS = (
    "View of the Ollama Multi Manager desktop app: its Ollama instances, the machine's CPU/RAM/GPU readings, installed models "
    "and downloads, logs, and request statistics. Request contents (prompts and answers) are not offered."
)


def instructions(control: bool = False, screenshots: bool = False) -> str:
    """What the server tells a client about itself: read-only, unless the control tools are switched on; and that a screenshot shows what is on
    screen (which can be what was asked and answered), when that tool is offered."""
    text = _BASE_INSTRUCTIONS
    if control:
        text += (" The reading tools change nothing. start_instance, stop_instance and restart_instance do change the app: "
                 "they act on the instances the user has set up, and stopping or restarting one interrupts what it is answering unless drain_seconds "
                 "gives it time to finish. Use them only when the user asked for it.")
        if screenshots:
            text += (" click_element, type_text, press_key, scroll_element and set_element_value operate the app's screen as a person does (any button "
                     "can be pressed, the delete buttons too: the app asks before it deletes); find_elements and get_page_text only look. Find the "
                     "element first, and look (take_screenshot) to check what a click did.")
    else:
        text += " Nothing here changes the app."
    if screenshots:
        text += (" take_screenshot shows what is on the app's screen as it is, which can include prompts and answers; take one only when the "
                 "user asked or when you need to see the screen, and prefer a selector for the part you need. A window that is hidden (in the tray, "
                 "minimized) can only be photographed as it is on screen (kind viewport): call get_app_state first to see which windows are shown.")
    return text


INSTRUCTIONS = instructions(False)

READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
START = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)
# what is done on the screen: a click can press any button, the delete button too
UI = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=False)
STOP = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False)
# a screenshot changes nothing in the app (it saves a file of its own and flashes a note on the page)
SHOT = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)


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


def register_screenshot_tool(server: MCPServer, shots: ShotBridge) -> None:
    """The screenshot tool. Registered wherever the app can take a picture (today: in developer mode). It has no switch of its own: the MCP token is its guard."""

    @server.tool(annotations=READ_ONLY)
    async def get_app_state() -> dict[str, Any]:
        """What the desktop app looks like right now: whether it runs in developer mode, whether the main window is shown, hidden (in the tray) or
        minimized and in focus, and the monitor windows that are open. Ask it before take_screenshot: a hidden window can only be photographed as
        it is on screen (kind viewport)."""
        try:
            return await shots.state()
        except ShotError as e:
            raise ToolError(str(e)) from e

    @server.tool(annotations=SHOT)
    async def take_screenshot(
        kind: Literal["viewport", "full", "element"] = "viewport", selector: str | None = None, instance_id: int | None = None,
        depth: int | None = None, max_side: int = DEFAULT_MAX_SIDE, open_monitor: bool = False,
    ) -> list[Image | str]:
        """A screenshot of the app's window, as the picture the client can look at (and the file it was saved to, on the machine running the app).
        kind: viewport = what is on screen now; full = the whole page with its scrolling boxes opened out (the long main view in one picture);
        element = the part of the page that `selector` (a CSS selector) names, which is required for this kind. instance_id: the monitor of that
        instance; without it the main window. The monitor has to be open, unless open_monitor is true: it is then opened for the picture without
        taking the user's focus, and closed again afterwards (one that was already open stays as it is). A window that is hidden (in the tray or
        minimized) can only be photographed with kind viewport; the other kinds are refused at once (get_app_state tells which windows are shown). depth: how many levels below <body> scrolling boxes are opened out
        (the default reaches the main view). max_side: the picture is scaled down so that its longer side is at most this many pixels (256 to
        4096, default 1568); the saved file keeps the full size. The screen can show prompts and answers."""
        try:
            shot = await shots.capture(kind, selector, instance_id, depth, clamp(max_side, 256, 4096), open_monitor)
        except ShotError as e:
            raise ToolError(str(e)) from e
        note = f"Saved on the machine running the app: {shot.file}\nShown {shot.width}x{shot.height}px"
        note += f" (scaled down from {shot.full_width}x{shot.full_height}px)." if (shot.width, shot.height) != (shot.full_width, shot.full_height) else "."
        return [Image(data=shot.png, format="png"), note]


def register_ui_tools(server: MCPServer, shots: ShotBridge) -> None:
    """Operating the app's screen: registered only with the control switch on and where the app can be operated (developer mode)."""

    async def act(action: str, **fields: Any) -> dict[str, Any]:
        request = {"action": action, **{k: v for k, v in fields.items() if v is not None}}
        try:
            return await shots.ui(request)
        except ShotError as e:
            raise ToolError(str(e)) from e

    @server.tool(annotations=READ_ONLY)
    async def find_elements(selector: str, text: str | None = None, limit: int = 20, instance_id: int | None = None) -> dict[str, Any]:
        """Elements of the app's screen that a CSS selector names (for example "button", ".card button", "#logs"), optionally only those whose text or label
        contains `text`: for each its index among the matches (what the other tools take as `index`), tag, id, class, text, label, whether it is visible,
        disabled or inert (something is open over it), its position and size on screen, and a checkbox's state or an input's value. instance_id: the monitor
        window of that instance (it has to be open); without it the main window, of which the monitor panel is a part. Looks only."""
        return await act("find", selector=selector, text=text, limit=limit, instance_id=instance_id)

    @server.tool(annotations=UI)
    async def click_element(selector: str, text: str | None = None, index: int = 0, double: bool = False, modifiers: list[str] | None = None,
                            instance_id: int | None = None) -> dict[str, Any]:
        """Click an element with the mouse, at its centre: the `index`-th of those that `selector` (and `text`) match, scrolled into view first. A button
        that is disabled, an element that is not visible and one under an open dialog or page (inert) are not clicked, and the error says why. The window has
        to be shown (in the tray or minimized it takes no input). Returns what was clicked; take_screenshot shows what it did."""
        return await act("click", selector=selector, text=text, index=index, double=double or None, modifiers=modifiers, instance_id=instance_id)

    @server.tool(annotations=UI)
    async def type_text(text: str, selector: str | None = None, clear: bool = False, index: int = 0, instance_id: int | None = None) -> dict[str, Any]:
        """Type text as a person does, into the field `selector` names (focused first), or into the field that has the focus when there is no selector.
        clear: select what is in the field first, so that the text replaces it. The window has to be shown. Use set_element_value for a field that does
        not take typing."""
        return await act("type", text=text, selector=selector, clear=clear or None, index=index, instance_id=instance_id)

    @server.tool(annotations=UI)
    async def press_key(key: str, modifiers: list[str] | None = None, instance_id: int | None = None) -> dict[str, Any]:
        """Press a key on the focused element: Enter, Escape, Tab, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1 to F12,
        or one character; modifiers: any of shift, control, alt, meta. The window has to be shown."""
        return await act("key", key=key, modifiers=modifiers, instance_id=instance_id)

    @server.tool(annotations=UI)
    async def scroll_element(delta_y: int = 0, delta_x: int = 0, selector: str | None = None, index: int = 0, instance_id: int | None = None) -> dict[str, Any]:
        """Scroll the element `selector` names (its `index`-th match), or the page when there is no selector, by delta_y (down is positive) and delta_x px.
        Returns where it is now and how long the content is."""
        return await act("scroll", delta_y=delta_y, delta_x=delta_x, selector=selector, index=index, instance_id=instance_id)

    @server.tool(annotations=UI)
    async def set_element_value(selector: str, value: str, text: str | None = None, index: int = 0, instance_id: int | None = None) -> dict[str, Any]:
        """Set the value of an input, a text area or a select (by the option's value or its text), and tell the page that it changed. For a switch or a
        checkbox use click_element."""
        return await act("set_value", selector=selector, value=value, text=text, index=index, instance_id=instance_id)

    @server.tool(annotations=READ_ONLY)
    async def get_page_text(selector: str | None = None, max_chars: int = 4000, instance_id: int | None = None) -> dict[str, Any]:
        """The text that is on the app's screen (of the element `selector` names, or of the whole page), at most `max_chars` (up to 20000). It can include
        what was asked and answered, as the screen does."""
        return await act("text", selector=selector, max_chars=max_chars, instance_id=instance_id)
