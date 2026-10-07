import mark from "@egant/assets/logo.svg";

const ASPECT = 622 / 456;

/** The egant mark, masked over the same travelling band the app's loader uses. */
export function Mark({ width = 22, wave = false }: { width?: number; wave?: boolean }) {
  return (
    <span
      aria-hidden
      className={`mark ${wave ? "mark-wave" : ""}`}
      style={{
        width,
        height: width / ASPECT,
        WebkitMaskImage: `url("${mark}")`,
        maskImage: `url("${mark}")`,
      }}
    />
  );
}
