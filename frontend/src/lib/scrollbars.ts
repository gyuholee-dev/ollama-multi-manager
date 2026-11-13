/**
 * Windows and Linux: marks the area that is being scrolled with data-scrolling, and takes the mark off a moment after the last scroll,
 * so that its scrollbar can show only meanwhile (styles/_polish.scss). One listener for the whole page: a scroll does not bubble, but it
 * can be caught on the way down.
 */
export function autoHideScrollbars(hideAfterMs = 900): void {
  const timers = new WeakMap<Element, number>();
  document.addEventListener('scroll', e => {
    const el = e.target instanceof Element ? e.target : document.documentElement;
    if (!el.hasAttribute('data-scrolling')) el.setAttribute('data-scrolling', '');
    window.clearTimeout(timers.get(el));
    timers.set(el, window.setTimeout(() => el.removeAttribute('data-scrolling'), hideAfterMs));
  }, { capture: true, passive: true });
}
