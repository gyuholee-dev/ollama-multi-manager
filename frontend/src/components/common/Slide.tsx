import { useEffect, useState, type ReactNode } from 'react';

const DURATION = 260; // a little more than the .25s of the transition in _models.scss

/** Content that slides open and shut. It is mounted when it opens and removed after it has closed, so what is inside starts afresh each time. */
export function Slide({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open); // the class that opens it: set a frame after mounting, so the opening is animated too
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), DURATION);
    return () => clearTimeout(timer);
  }, [open]);
  if (!mounted) return null;
  return <div className={shown ? 'slide slide--open' : 'slide'}><div className="slide__inner">{children}</div></div>;
}
