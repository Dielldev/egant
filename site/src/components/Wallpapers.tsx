import { WALLPAPERS } from "../content";
import { Reveal } from "./Reveal";
import { ScrollFrame } from "./ScrollFrame";

/** Real launch screens, each with its own wallpaper. */
export function Wallpapers() {
  return (
    <Reveal className="wallpapers stagger">
      {WALLPAPERS.map((w) => (
        <figure key={w.name}>
          <ScrollFrame mode="through" className="frame">
            <img
              src={w.src}
              alt={`egant's launch screen with the ${w.name} wallpaper`}
              loading="lazy"
            />
          </ScrollFrame>
          <figcaption>{w.name}</figcaption>
        </figure>
      ))}
    </Reveal>
  );
}
