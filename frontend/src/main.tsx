import { createRoot } from 'react-dom/client';
import App from './App';
import { hasCustomTitleBar } from './desktop';
import { detectPlatform } from './lib/platform';
import { monitorIdFromHash } from './lib/route';
import './styles/style.scss';

document.documentElement.dataset.platform = detectPlatform(); // (the look that differs by system: styles/_select.scss)
if (hasCustomTitleBar()) document.documentElement.dataset.titlebar = 'custom';

// #monitor=<id> opens one instance's monitor on its own (read here, before the client removes the token from the address)
createRoot(document.getElementById('root')!).render(<App monitor={monitorIdFromHash(location.hash) ?? undefined} />);
