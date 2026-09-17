import mark from "../assets/logo.svg";

/** The mark's proportions, straight out of the artwork's viewBox. Height is
 * always derived from width, so the two can never be set out of step. */
const ASPECT = 622 / 456;

/** The app's mark with the status line's wave rolling across it: the loader
 * for a wait that owns the whole window.
 *
 * Same band, same 2.6s beat, same palette colours as the shimmering verb under
 * a running turn — `.shimmer` clips that gradient to its glyphs, and this masks
 * the very same gradient with the mark instead, so the logo runs white as the
 * band crosses it and sits back at `--faint` behind it. Two places in the app
 * wait on something; they wait the same way.
 */
export function LogoLoader({
  /** Width in px. The height follows the artwork. */
  width = 96,
  /** Screen-reader name. Left out when something right beside it already says
   * what is happening — the mark is decorative then, and repeating the label
   * would just have it read twice. */
  label,
}: {
  width?: number;
  label?: string;
}) {
  const named = label !== undefined && label !== "";
  return (
    <span
      {...(named ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className="logo-wave block shrink-0"
      style={{
        width,
        height: width / ASPECT,
        // The asset URL lives here rather than in the stylesheet, so
        // `index.css` never has to know where Vite put the file. The quotes
        // are load-bearing: a production build inlines the mark as a data URI
        // that still carries single quotes around its attributes, and those
        // are illegal inside a bare `url()` — unquoted, the declaration is
        // dropped and the gradient paints as a naked rectangle.
        WebkitMaskImage: `url("${mark}")`,
        maskImage: `url("${mark}")`,
      }}
    />
  );
}
