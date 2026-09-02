import { useEffect } from 'react';

/**
 * Prevents the page behind a modal/drawer from scrolling, and compensates for
 * the removed scrollbar so the layout doesn't jump.
 */
export function useScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    const { overflow, paddingRight } = document.body.style;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [active]);
}
