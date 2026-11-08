import { createRoot } from 'react-dom/client';
import App from './App';
import { hasCustomTitleBar } from './desktop';
import { monitorIdFromHash } from './lib/route';
import './styles/style.scss';

if (hasCustomTitleBar()) document.documentElement.dataset.titlebar = 'custom';

// #monitor=<id> opens one instance's monitor on its own (read here, before the client removes the token from the address)
createRoot(document.getElementById('root')!).render(<App monitor={monitorIdFromHash(location.hash) ?? undefined} />);
