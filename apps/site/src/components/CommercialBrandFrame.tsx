import type { ReactNode } from "react";
import styles from "./CommercialBrandFrame.module.css";

function CardCorner({
  position,
}: {
  position: "topLeft" | "topRight" | "bottomRight" | "bottomLeft";
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 32 32"
      className={[styles["corner"], styles[position]].join(" ")}
    >
      <path d="M0 0H32A32 32 0 0 1 0 32Z" className={styles["navy"]} />
      <path
        d="M32 0A32 32 0 0 1 0 32"
        className={styles["goldLine"]}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A paper-and-ink frame; decorations never clip or cover the page content. */
export function CommercialBrandFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles["frame"]}>
      <div className={styles["paper"]}>
        <div className={styles["content"]}>{children}</div>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 1200 64"
          preserveAspectRatio="none"
          className={styles["bottomCurve"]}
        >
          <path
            d="M0 20C230 18 350 58 635 60C860 62 1035 43 1200 22V64H0Z"
            className={styles["navy"]}
          />
          <path
            d="M0 20C230 18 350 58 635 60"
            className={styles["goldLine"]}
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M648 64C825 58 970 10 1200 4V64Z"
            className={styles["green"]}
          />
        </svg>
        <CardCorner position="topLeft" />
        <CardCorner position="topRight" />
        <CardCorner position="bottomRight" />
        <CardCorner position="bottomLeft" />
      </div>
    </div>
  );
}
