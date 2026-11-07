import { useEffect, useRef, useState } from "react";

/** True once the element has scrolled into view; never flips back. */
export function useInView<T extends Element>(threshold = 0.2) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin: "0px 0px -60px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen] as const;
}

export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Maps an element's position in the viewport to a 0-1 progress value. */
export type Progress = (rect: DOMRect, vh: number) => number;

/** 0 as the element's top meets the bottom edge, 1 once it's 60% up the screen. */
export const enterProgress: Progress = (r, vh) => clamp((vh - r.top) / (vh * 0.6));
/** 0 as it enters at the bottom, 1 as it leaves at the top. */
export const throughProgress: Progress = (r, vh) => clamp((vh - r.top) / (vh + r.height));
/** 0 while it's in place, 1 once it has scrolled almost fully away. */
export const leaveProgress: Progress = (r) => clamp(-r.top / (r.height * 0.9));

/** Writes `--p` (0-1) on the element while it's on screen, so CSS can turn
 * scroll position into transforms. Idle (no listeners) when off screen, and
 * left at `rest` for people who prefer reduced motion. */
export function useScrollProgress<T extends HTMLElement>(compute: Progress, rest: number) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--p", String(rest));
    if (prefersReducedMotion()) return;

    let raf = 0;
    let live = false;
    const update = () => {
      raf = 0;
      el.style.setProperty("--p", compute(el.getBoundingClientRect(), window.innerHeight).toFixed(3));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const stop = () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !live) {
        live = true;
        update();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
      } else if (!entry.isIntersecting && live) {
        live = false;
        stop();
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      stop();
      cancelAnimationFrame(raf);
    };
  }, [compute, rest]);
  return ref;
}
