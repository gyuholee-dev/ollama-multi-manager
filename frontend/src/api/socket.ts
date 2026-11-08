import { socketUrl } from './client';
import type { SocketMessage } from './types';

const RECONNECT_MS = 2000;

/** One auto-reconnecting WebSocket. Returns a function that stops it for good. */
export function connectSocket(onMessage: (m: SocketMessage) => void, onStatus: (up: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    const socket = new WebSocket(socketUrl());
    ws = socket;
    socket.onopen = () => onStatus(true);
    socket.onmessage = (e: MessageEvent<string>) => {
      try { onMessage(JSON.parse(e.data) as SocketMessage); } catch { /* ignore malformed frames */ }
    };
    socket.onclose = () => {
      onStatus(false);
      if (!stopped) timer = setTimeout(open, RECONNECT_MS);
    };
    socket.onerror = () => socket.close();
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
