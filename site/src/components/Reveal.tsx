import type { CSSProperties, ElementType, ReactNode } from "react";
import { useInView } from "../useReveal";

/** Fades and lifts its children in the first time they scroll into view. */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className = "",
  style,
  children,
}: {
  as?: ElementType;
  delay?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <Tag
      ref={ref}
      className={`reveal ${seen ? "is-in" : ""} ${className}`}
      style={{ ...style, transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
