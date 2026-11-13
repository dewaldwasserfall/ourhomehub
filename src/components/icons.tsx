/**
 * Icon set. Drawn on a 24px grid with 1.8px rounded strokes to sit naturally
 * next to the system font (SF Symbols weight "regular").
 * Every icon is decorative by default (aria-hidden); give the parent control
 * an accessible label instead.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (p: IconProps) => (
  <Svg strokeWidth={2.6} {...p}>
    <path d="M5.5 12.5l4.2 4.2L18.5 7.8" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg strokeWidth={2.4} {...p}>
    <path d="M15 4.5L7.5 12l7.5 7.5" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const ArrowUpIcon = (p: IconProps) => (
  <Svg strokeWidth={2.4} {...p}>
    <path d="M12 19V5.5M6 11.5l6-6 6 6" />
  </Svg>
);

/** Four-point sparkle used for anything the app suggested. */
export const SparkleIcon = (p: IconProps) => (
  <Svg stroke="none" fill="currentColor" {...p}>
    <path d="M12 2.5c.5 4.9 2.6 7 7.5 7.5-4.9.5-7 2.6-7.5 7.5-.5-4.9-2.6-7-7.5-7.5 4.9-.5 7-2.6 7.5-7.5z" />
    <path d="M18.5 15c.2 2 1 2.8 3 3-2 .2-2.8 1-3 3-.2-2-1-2.8-3-3 2-.2 2.8-1 3-3z" opacity=".7" />
  </Svg>
);

/** Same sparkle, filled with the iridescent gradient. */
export function GlowSparkle({ size = 18, id = "glow-sparkle" }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="glow-icon">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8cff" />
          <stop offset=".35" stopColor="#9b6bff" />
          <stop offset=".68" stopColor="#ff6ea8" />
          <stop offset="1" stopColor="#ffb547" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M12 2.5c.5 4.9 2.6 7 7.5 7.5-4.9.5-7 2.6-7.5 7.5-.5-4.9-2.6-7-7.5-7.5 4.9-.5 7-2.6 7.5-7.5z"
      />
      <path
        fill={`url(#${id})`}
        opacity=".75"
        d="M18.5 15c.2 2 1 2.8 3 3-2 .2-2.8 1-3 3-.2-2-1-2.8-3-3 2-.2 2.8-1 3-3z"
      />
    </svg>
  );
}

/** Tab: Lists */
export const ListsIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <path d="M8 9h8M8 12.5h8M8 16h5" />
  </Svg>
);

/** Tab: Rhythms (a pulse through repeating beats) */
export const RhythmIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12h3.2l2.1-5.5 3.4 11 3.1-8.5 1.9 3h5.3" />
  </Svg>
);

/** Tab: Household */
export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.8 10.4L12 3.8l8.2 6.6V19a1.5 1.5 0 01-1.5 1.5H5.3A1.5 1.5 0 013.8 19z" />
    <path d="M9.5 20.5v-5.2a1 1 0 011-1h3a1 1 0 011 1v5.2" />
  </Svg>
);

export const CartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4h2.2l2.2 10.6a1.5 1.5 0 001.5 1.2h8.4a1.5 1.5 0 001.5-1.2L20.5 8H6.3" />
    <circle cx="9.5" cy="19.5" r="1.2" />
    <circle cx="17" cy="19.5" r="1.2" />
  </Svg>
);

export const ChecklistIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5l1.6 1.6L8.5 5.2M4 12.5l1.6 1.6 2.9-2.9M4 18.5l1.6 1.6 2.9-2.9M11.5 7h8.5M11.5 13h8.5M11.5 19h8.5" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v11M7.8 7.5L12 3.3l4.2 4.2" />
    <path d="M8 11H6.5A1.5 1.5 0 005 12.5v7A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5v-7a1.5 1.5 0 00-1.5-1.5H16" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4v4.5H15" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg stroke="none" fill="currentColor" {...p}>
    <circle cx="6" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="18" cy="12" r="1.7" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);

export const GoogleIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 01-2.4 3.6v3h3.9c2.2-2.1 3.5-5.2 3.5-8.8z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0012 24z" />
    <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 010-4.6V6.6H1.3a12 12 0 000 10.8z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 001.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
  </svg>
);

/** Tab: Calendar */
export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <circle cx="8.5" cy="14.5" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

/** Marks a repeating event. */
export const RepeatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 3.5l3 3-3 3" />
    <path d="M4 11.5v-1a4 4 0 014-4h12" />
    <path d="M7 20.5l-3-3 3-3" />
    <path d="M20 12.5v1a4 4 0 01-4 4H4" />
  </Svg>
);

export const PinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.3" />
  </Svg>
);

/** Tab: Today (a sun on the horizon) */
export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5L7 17M17 7l1.5-1.5" />
  </Svg>
);

/** Routines: a morning checklist */
export const RoutineIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="3" />
    <path d="M8 9l1.4 1.4L12 7.8M8 15l1.4 1.4L12 13.8M14 9.5h2.5M14 15.5h2.5" />
  </Svg>
);

/** Zones: the house split into areas */
export const ZoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 3.5v17M3.5 12H12" />
  </Svg>
);

/** Chores: a sponge-and-sparkle cleaning mark */
export const ChoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="11" width="13" height="8.5" rx="2.5" />
    <path d="M6.5 11V9a3.5 3.5 0 017 0v2" />
    <path d="M18.5 4v4M16.5 6h4" />
  </Svg>
);

/** School holidays: a suitcase */
export const HolidayIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="7.5" width="17" height="12" rx="3" />
    <path d="M9 7.5V5.8A1.3 1.3 0 0110.3 4.5h3.4A1.3 1.3 0 0115 5.8v1.7M9 7.5v12M15 7.5v12" />
  </Svg>
);

/** Reorder handle */
export const GripIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9h12M6 15h12" />
  </Svg>
);
