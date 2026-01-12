export const TEAM_CARD =
  "rounded-3xl border border-slate-200 bg-white/90 shadow-xl shadow-slate-200/50 backdrop-blur";

export const TEAM_CARD_PADDED = `${TEAM_CARD} p-6`;

export const TEAM_SECTION_TITLE = "text-lg font-semibold text-slate-900";
export const TEAM_SECTION_SUBTITLE = "mt-1 text-sm text-slate-600";

export const TEAM_INPUT =
  "rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100";

export const TEAM_INPUT_COMPACT =
  "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100";

export const TEAM_SELECT = TEAM_INPUT_COMPACT;

type TeamButtonVariant = "primary" | "secondary" | "danger";
type TeamButtonSize = "sm" | "md";

export function teamButtonClass(
  variant: TeamButtonVariant = "secondary",
  size: TeamButtonSize = "md"
): string {
  const sizeClass =
    size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm";

  switch (variant) {
    case "primary":
      return `inline-flex items-center justify-center rounded-full bg-primary-600 ${sizeClass} font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-200`;
    case "danger":
      return `inline-flex items-center justify-center rounded-full border border-rose-200 ${sizeClass} font-semibold text-rose-700 transition hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-200`;
    default:
      return `inline-flex items-center justify-center rounded-full border border-slate-200 bg-white ${sizeClass} font-semibold text-slate-700 shadow-sm transition hover:border-primary-300 hover:text-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-100`;
  }
}

export const TEAM_EMPTY_STATE =
  "rounded-2xl border border-dashed border-slate-200 bg-white/80 p-5 text-sm text-slate-500 shadow-sm";

