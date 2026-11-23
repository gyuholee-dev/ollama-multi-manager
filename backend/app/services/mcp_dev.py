"""The tools only a developer's agent gets: the app's screen (its state, screenshots, clicks and typing). They are not part of what the MCP server offers
users (mcp_tools.py): they are registered only when the app runs in developer mode (the way to Electron's listener is there: dev_bridge.py), and the ones
that operate the screen only with the "control" switch on as well.

A screenshot here is made for a model to look at, not for a person to keep: by default it is taken at scale 1 (CSS pixels) and sent as JPEG 85, which is
a fraction of the size of the picture at the screen's scale, and it is handed to the client only: nothing of it is saved on disk. (What a developer takes
by hand, from the right-click menu, is another matter: a PNG at the screen's scale, saved and put on the clipboard.)
"""
from __future__ import annotations

from typing import Any, Literal

from mcp.server.mcpserver import Image, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from app.services.dev_bridge import DevBridge, DevError
from app.services.mcp_tools import READ_ONLY, clamp

DEFAULT_MAX_SIDE = 1568  # the longer side of the picture handed to the client
# what is done on the screen: a click can press any button, the delete button too
UI = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=False)
# a screenshot changes nothing in the app (it flashes a note on the page, which is gone before the next picture)
SHOT = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)


def dev_instructions(control: bool = False) -> str:
    """What a developer's agent is told besides what any client is told (mcp_tools.instructions): the screen of the app, and how to look at it."""
    text = (" take_screenshot shows what is on the app's screen as it is, which can include prompts and answers; take one only when the "
            "user asked or when you need to see the screen, and prefer a selector for the part you need. The picture is small by default (scale 1, "
            "JPEG): ask for quality full only when the detail needs it. A window that is hidden (in the tray, minimized) can only be photographed as it is "
            "on screen (kind viewport): call get_app_state first to see which windows are shown.")
    if control:
        text += (" click_element, type_text, press_key, scroll_element and set_element_value operate the app's screen as a person does (any button "
                 "can be pressed, the delete buttons too: the app asks before it deletes); find_elements and get_page_text only look. Find the "
                 "element first, and look (take_screenshot) to check what a click did.")
    return text


def register_dev_tools(server: MCPServer, dev: DevBridge, control: bool) -> None:
    """The developer's tools: the state and screenshots always (wherever the app can be reached), operating the screen with the control switch."""
    register_screenshot_tools(server, dev)
    if control:
        register_ui_tools(server, dev)


def register_screenshot_tools(server: MCPServer, shots: DevBridge) -> None:
    """The state of the app and the screenshot tool. Registered wherever the app can be reached (developer mode); no switch of their own: the MCP token is their guard."""

    @server.tool(annotations=READ_ONLY)
    async def get_app_state() -> dict[str, Any]:
        """What the desktop app looks like right now: whether it runs in developer mode, whether the main window is shown, hidden (in the tray) or
        minimized and in focus, and the monitor windows that are open. Ask it before take_screenshot: a hidden window can only be photographed as
        it is on screen (kind viewport)."""
        try:
            return await shots.state()
        except DevError as e:
            raise ToolError(str(e)) from e

    @server.tool(annotations=SHOT)
    async def take_screenshot(
        kind: Literal["viewport", "full", "element"] = "viewport", selector: str | None = None, instance_id: int | None = None,
        depth: int | None = None, max_side: int = DEFAULT_MAX_SIDE, open_monitor: bool = False, quality: Literal["reduced", "full"] = "reduced",
    ) -> list[Image | str]:
        """A screenshot of the app's window, as the picture the client can look at (it is not saved anywhere).
        kind: viewport = what is on screen now; full = the whole page with its scrolling boxes opened out (the long main view in one picture);
        element = the part of the page that `selector` (a CSS selector) names, which is required for this kind. instance_id: the monitor of that
        instance; without it the main window (a monitor shown in the panel of the main window is taken by its instance_id as well). The monitor has to be
        open, unless open_monitor is true: it is then opened for the picture without taking the user's focus, and closed again afterwards (one that was
        already open stays as it is). A window that is hidden (in the tray or minimized) can only be photographed with kind viewport; the other kinds are
        refused at once (get_app_state tells which windows are shown). depth: how many levels below <body> scrolling boxes are opened out (the default
        reaches the main view). quality: reduced (the default) = taken at scale 1 and sent as JPEG 85, small; full = at the screen's scale (twice the
        pixels on a retina screen) and as PNG, large: only when the detail needs it. max_side: the picture is scaled down so that its longer side is at most
        this many pixels (256 to 4096, default 1568). The screen can show prompts and answers."""
        try:
            shot = await shots.capture(kind, selector, instance_id, depth, clamp(max_side, 256, 4096), open_monitor, quality)
        except DevError as e:
            raise ToolError(str(e)) from e
        note = f"Shown {shot.width}x{shot.height}px"
        note += f" (scaled down from {shot.full_width}x{shot.full_height}px)." if (shot.width, shot.height) != (shot.full_width, shot.full_height) else "."
        return [Image(data=shot.data, format="jpeg" if shot.mime == "image/jpeg" else "png"), note]


def register_ui_tools(server: MCPServer, shots: DevBridge) -> None:
    """Operating the app's screen: registered only with the control switch on and where the app can be operated (developer mode)."""

    async def act(action: str, **fields: Any) -> dict[str, Any]:
        request = {"action": action, **{k: v for k, v in fields.items() if v is not None}}
        try:
            return await shots.ui(request)
        except DevError as e:
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
