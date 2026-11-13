import { createRoot } from 'react-dom/client';
import App from './App';
import { hasCustomTitleBar, hasOverlayTitleBar, shellHeaderHeight } from './desktop';
import { detectPlatform } from './lib/platform';
import { setScrollbarWidth } from './lib/scrollbars';
import { monitorIdFromHash } from './lib/route';
import './styles/style.scss';

const platform = detectPlatform();
document.documentElement.dataset.platform = platform; // (the look that differs by system: styles/_fonts.scss, _polish.scss)
if (shellHeaderHeight()) document.documentElement.style.setProperty('--header-h', `${shellHeaderHeight()}px`);
setScrollbarWidth();
if (hasCustomTitleBar()) document.documentElement.dataset.titlebar = 'custom';
else if (hasOverlayTitleBar()) document.documentElement.dataset.titlebar = 'overlay';

// #monitor=<id> opens one instance's monitor on its own (read here, before the client removes the token from the address)
createRoot(document.getElementById('root')!).render(<App monitor={monitorIdFromHash(location.hash) ?? undefined} />);
