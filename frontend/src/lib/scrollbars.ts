/**
 * The room a scrollbar takes beside the content, in px: 0 where the bars float over it (macOS), about 8 where they are always shown
 * (Windows, Linux). Measured with a scrolling box that gets the page's bars, and put in --sbw on <html>: the scrolling areas take it
 * out of their right padding (styles/_polish.scss), so that the bar sits in the padding and the two sides look alike.
 */
export function setScrollbarWidth(): void {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow-y:scroll'; // (the page's own rules for scrollbars apply to it)
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  document.documentElement.style.setProperty('--sbw', `${width}px`);
}
