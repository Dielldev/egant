import type { CSSProperties, ReactNode } from "react";
import { enterProgress, throughProgress, useScrollProgress } from "../useReveal";

/** A box whose `--p` follows the scroll. "enter" eases it in (slides up and
 * settles); "through" drives a slow parallax on the image inside it. */
export function ScrollFrame({
  mode = "enter",
  className = "",
  style,
  children,
}: {
  mode?: "enter" | "through";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const enter = mode === "enter";
  const ref = useScrollProgress<HTMLDivElement>(enter ? enterProgress : throughProgress, enter ? 1 : 0.5);
  return (
    <div ref={ref} className={`${enter ? "scroll-enter" : "parallax"} ${className}`} style={style}>
      {children}
    </div>
  );
}
