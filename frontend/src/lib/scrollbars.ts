/**
 * Windows and Linux: scrollbars that hide until they are needed, drawn by hand. (macOS has them itself.) The system's own bars are
 * turned off (styles/_polish.scss), so they take no room and cannot disagree with the padding. One thumb for the whole page: it shows at
 * the right edge of the area that is being scrolled, or of the one the pointer is at the right edge of, and fades out a moment later.
 * The thumb lives in the top layer (popover) so that it also shows over a dialog. Vertical bars only.
 */
const HIDE_AFTER_MS = 900;
const EDGE = 12; // px from an area's right edge where the pointer brings the thumb up
const INSET = 4; // the thumb keeps this far from the ends and from the edge
const MIN_THUMB = 28;

const scrolls = (el: Element): boolean => {
  const o = getComputedStyle(el).overflowY;
  return (o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1;
};

/** The nearest area around `el` that has something to scroll. */
const scrollerOf = (el: Element | null): HTMLElement | null => {
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) if (scrolls(e)) return e as HTMLElement;
  return null;
};

export function overlayScrollbars(): void {
  const thumb = document.createElement('div');
  thumb.className = 'sbthumb';
  thumb.setAttribute('popover', 'manual');
  document.body.append(thumb);

  let target: HTMLElement | null = null;
  let timer = 0;
  let drag: { y: number; top: number; ratio: number } | null = null;

  const geometry = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const track = r.height - 2 * INSET;
    const size = Math.max(MIN_THUMB, (track * el.clientHeight) / el.scrollHeight);
    const range = el.scrollHeight - el.clientHeight;
    const top = r.top + INSET + ((track - size) * el.scrollTop) / range;
    return { r, size, top, ratio: range / (track - size) }; // ratio: scroll distance per px the thumb is dragged
  };

  const hide = () => {
    thumb.classList.remove('on');
    target = null;
  };
  const later = () => {
    window.clearTimeout(timer);
    if (!drag) timer = window.setTimeout(hide, HIDE_AFTER_MS);
  };

  const show = (el: HTMLElement) => {
    if (!el.isConnected || !scrolls(el)) return hide();
    const g = geometry(el);
    thumb.style.height = `${g.size}px`;
    thumb.style.top = `${g.top}px`;
    thumb.style.left = `${g.r.right - INSET - 4}px`;
    if (target !== el || !thumb.matches(':popover-open')) {
      if (thumb.matches(':popover-open')) thumb.hidePopover();
      thumb.showPopover(); // (shown last, so it is above a dialog opened since)
    }
    target = el;
    thumb.classList.add('on');
    later();
  };

  // scrolling shows it (a scroll does not bubble: it is caught on the way down)
  document.addEventListener('scroll', e => {
    if (drag || !(e.target instanceof HTMLElement)) return;
    if (e.target === target || scrolls(e.target)) show(e.target);
  }, { capture: true, passive: true });

  // the pointer at the right edge of an area brings it up, so that it can be grabbed
  let moving = 0;
  document.addEventListener('pointermove', e => {
    if (drag || moving) return;
    moving = requestAnimationFrame(() => {
      moving = 0;
      const el = scrollerOf(document.elementFromPoint(e.clientX, e.clientY));
      if (el && e.clientX >= el.getBoundingClientRect().right - EDGE) show(el);
    });
  }, { passive: true });

  // dragging the thumb
  thumb.addEventListener('pointerdown', e => {
    if (!target) return;
    const g = geometry(target);
    drag = { y: e.clientY, top: target.scrollTop, ratio: g.ratio };
    thumb.setPointerCapture(e.pointerId);
    thumb.classList.add('drag');
    e.preventDefault();
  });
  thumb.addEventListener('pointermove', e => {
    if (!drag || !target) return;
    target.scrollTop = drag.top + (e.clientY - drag.y) * drag.ratio;
    const g = geometry(target);
    thumb.style.top = `${g.top}px`;
  });
  const drop = () => {
    drag = null;
    thumb.classList.remove('drag');
    later();
  };
  thumb.addEventListener('pointerup', drop);
  thumb.addEventListener('pointercancel', drop);
  thumb.addEventListener('pointerenter', () => window.clearTimeout(timer)); // stays while the pointer is on it
  thumb.addEventListener('pointerleave', later);
}
