/** Puts text on the clipboard. Resolves false when the browser refuses (the caller shows nothing then). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // a page without clipboard access (plain http on a LAN address): the old way, through a selected text area
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { return document.execCommand('copy'); } finally { area.remove(); }
  }
}
