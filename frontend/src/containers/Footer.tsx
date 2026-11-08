import { useMonitorStore } from '@/stores/monitorStore';
import { useUiStore } from '@/stores/uiStore';

export function Footer() {
  const status = useUiStore((s) => s.status);
  const version = useMonitorStore((s) => s.info?.version);
  return (
    <footer>
      <div>
        <span className="l"><span className="material-icons">bug_report</span><span id="status">{status}</span></span>
        <a id="ver" href="https://github.com/gyuholee-dev/ollama-multi-manager" target="_blank" rel="noopener noreferrer">
          ollama-multi-manager{version ? ` v${version}` : ''}
        </a>
      </div>
    </footer>
  );
}
