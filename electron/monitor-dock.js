// Where a monitor window opens when it is detached from the panel of the main window: on the side the panel was on, against that side of the main window,
// as high as the main window. What would go over the edge of the display is moved back against that edge.

/** `main`: the main window's bounds { x, y, width, height }; `side`: 'left' or 'right' (where the panel was); `area`: the work area of the display the main window is on;
 * `width`: the monitor window's width. Resolves { x, y, width, height } in whole pixels. */
export function dockBounds(main, side, area, width) {
  const height = Math.min(main.height, area.height);
  const wanted = side === 'left' ? main.x - width : main.x + main.width;
  const x = Math.max(area.x, Math.min(wanted, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(main.y, area.y + area.height - height));
  return { x: Math.round(x), y: Math.round(y), width, height };
}

/** 'left' or 'right' when the page names a side, else null (the window opens by its saved or its first place). */
export const dockSide = side => (side === 'left' || side === 'right' ? side : null);
