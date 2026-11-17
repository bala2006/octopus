import type { CSSProperties } from "react";

/**
 * The app logo. It is the main lead's avatar, so the lead reads as Octopus itself. The logo sits on a cream disc, because
 * its orange body disappears on the lead's orange avatar color.
 */
export function AppLogo({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      className={className}
      style={{ ...style, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "9999px", background: "#F5EFE6" }}
    >
      <img src="/octopus.svg" alt="" style={{ width: "74%", height: "74%" }} />
    </span>
  );
}
