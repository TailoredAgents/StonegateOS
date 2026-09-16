import type { ReactNode } from "react";
import styles from "./CommercialBrandFrame.module.css";

function FlowingEdge({ position }: { position: "top" | "bottom" }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1440 180"
      preserveAspectRatio="none"
      className={`${styles["edge"]} ${styles[position]}`}
    >
      <path
        d="M0 14C400 158 780 180 1100 120V180H0Z"
        className={styles["gold"]}
      />
      <path
        d="M620 151C1000 140 1230 69 1440 8V180H620Z"
        className={styles["green"]}
      />
      <path
        d="M0 36C400 172 1020 172 1440 36V180H0Z"
        className={styles["navy"]}
      />
    </svg>
  );
}

/** Flowing color bands occupy their own space, clear of content and controls. */
export function CommercialBrandFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles["frame"]}>
      <FlowingEdge position="top" />
      <div className={styles["content"]}>{children}</div>
      <FlowingEdge position="bottom" />
    </div>
  );
}
