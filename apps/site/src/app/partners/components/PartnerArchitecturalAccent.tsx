/** A quiet nod to the Stonegate name: a series of open, architectural arches. */
export function PartnerArchitecturalAccent({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 360 240"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="1">
        <path d="M42 240V142a138 138 0 0 1 276 0v98" />
        <path d="M62 240V142a118 118 0 0 1 236 0v98" />
        <path d="M82 240V142a98 98 0 0 1 196 0v98" />
        <path d="M102 240V142a78 78 0 0 1 156 0v98" />
        <path d="M122 240V142a58 58 0 0 1 116 0v98" />
        <path d="M142 240V142a38 38 0 0 1 76 0v98" />
        <path d="M0 202h360M0 222h360" opacity=".5" />
      </g>
      <circle cx="318" cy="43" r="4" fill="currentColor" stroke="none" />
      <path d="M26 77h12m-6-6v12" stroke="currentColor" />
    </svg>
  );
}
