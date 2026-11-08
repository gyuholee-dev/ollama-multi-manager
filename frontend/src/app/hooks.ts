import { useMemo } from 'react';
import type { GpuDevice } from '@/api/types';
import { buildViews, externalView, type ExternalView, type InstanceView } from '@/lib/derive';
import { useInstancesStore } from '@/stores/instancesStore';
import { useMonitorStore } from '@/stores/monitorStore';

const NO_DEVICES: GpuDevice[] = [];

/** The instances as the screens want them (the stored record plus what the latest snapshot says). */
export function useViews(): InstanceView[] {
  const list = useInstancesStore((s) => s.list);
  const snap = useMonitorStore((s) => s.snap);
  return useMemo(() => buildViews(list, snap), [list, snap]);
}

export function useExternal(): ExternalView | null {
  const snap = useMonitorStore((s) => s.snap);
  return useMemo(() => externalView(snap), [snap]);
}

export const useDevices = (): GpuDevice[] => useMonitorStore((s) => s.snap?.gpu?.devices ?? NO_DEVICES);
