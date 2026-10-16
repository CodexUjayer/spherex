/** A simplified NASA-style "meatball" logo: blue disc, white orbiting text,
 *  red chevron, scattered stars. Pure SVG, no external assets. */
export function NasaLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="NASA"
      className="shrink-0"
    >
      <circle cx="50" cy="50" r="48" fill="#0b3d91" />
      {/* orbit ring */}
      <ellipse
        cx="50"
        cy="50"
        rx="46"
        ry="20"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.85"
        strokeWidth="1.5"
        transform="rotate(-20 50 50)"
      />
      {/* red chevron (swoosh) */}
      <path
        d="M8 60 Q 30 46 55 50 Q 70 52 92 38 Q 70 64 45 60 Q 28 58 8 60 Z"
        fill="#fc3d21"
        opacity="0.95"
      />
      {/* stars */}
      <g fill="#ffffff">
        <circle cx="22" cy="30" r="1.6" />
        <circle cx="38" cy="20" r="1.2" />
        <circle cx="64" cy="22" r="1.4" />
        <circle cx="80" cy="34" r="1.2" />
        <circle cx="30" cy="74" r="1.3" />
        <circle cx="72" cy="80" r="1.2" />
      </g>
      {/* NASA wordmark */}
      <text
        x="50"
        y="60"
        textAnchor="middle"
        fontFamily="'Helvetica Neue', Arial, sans-serif"
        fontSize="20"
        fontWeight="700"
        letterSpacing="1"
        fill="#ffffff"
      >
        NASA
      </text>
    </svg>
  );
}
