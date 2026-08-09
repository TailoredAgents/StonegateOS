export const TEAM_CARD =
  "rounded-3xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] text-[color:var(--team-text)] shadow-[0_24px_56px_var(--team-card-shadow)] backdrop-blur";

export const TEAM_CARD_PADDED = `${TEAM_CARD} p-4 sm:p-6`;

export const TEAM_PAGE_HEADER = `${TEAM_CARD_PADDED} space-y-4`;

export const TEAM_SECTION_TITLE =
  "text-lg font-semibold text-[color:var(--team-text)]";
export const TEAM_SECTION_SUBTITLE =
  "mt-1 text-sm text-[color:var(--team-text-muted)]";

export const TEAM_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--team-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--team-focus-offset)]";

export const TEAM_INPUT = `min-h-11 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-3 text-sm text-[color:var(--team-text)] shadow-sm placeholder:text-[color:var(--team-text-soft)] focus-visible:border-[color:var(--team-focus-ring)] ${TEAM_FOCUS_RING}`;

export const TEAM_INPUT_COMPACT = `min-h-11 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm text-[color:var(--team-text)] shadow-sm placeholder:text-[color:var(--team-text-soft)] focus-visible:border-[color:var(--team-focus-ring)] ${TEAM_FOCUS_RING}`;

export const TEAM_SELECT = TEAM_INPUT_COMPACT;

export const TEAM_SUBNAV =
  "grid grid-cols-2 gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-2 sm:flex sm:flex-wrap";

export const TEAM_ACTION_BAR =
  "sticky bottom-0 z-20 flex flex-wrap items-center justify-end gap-2 border-t border-[color:var(--team-border)] bg-[color:var(--team-card)] p-3 backdrop-blur";

type TeamButtonVariant = "primary" | "secondary" | "danger";
type TeamButtonSize = "sm" | "md";

export function teamButtonClass(
  variant: TeamButtonVariant = "secondary",
  size: TeamButtonSize = "md",
): string {
  const sizeClass = size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm";
  const baseClass = `inline-flex min-h-11 min-w-11 items-center justify-center rounded-full font-semibold transition ${TEAM_FOCUS_RING}`;
  const disabledClass =
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60";

  switch (variant) {
    case "primary":
      return `${baseClass} bg-[color:var(--team-action-primary)] ${sizeClass} text-[color:var(--team-action-primary-text)] shadow-[0_8px_24px_var(--team-action-shadow)] hover:bg-[color:var(--team-action-primary-hover)] ${disabledClass}`;
    case "danger":
      return `${baseClass} border border-[color:var(--team-danger-border)] bg-[color:var(--team-danger-surface)] ${sizeClass} text-[color:var(--team-danger-text)] hover:bg-[color:var(--team-danger-surface-hover)] ${disabledClass}`;
    default:
      return `${baseClass} border border-[color:var(--team-border)] bg-[color:var(--team-surface)] ${sizeClass} text-[color:var(--team-text)] shadow-sm hover:border-[color:var(--team-focus-ring)] hover:text-[color:var(--team-link)] ${disabledClass}`;
  }
}

export const TEAM_EMPTY_STATE =
  "rounded-2xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-card)] p-5 text-sm text-[color:var(--team-text-soft)] shadow-sm";

export const TEAM_SKELETON =
  "animate-pulse rounded-xl bg-[color:var(--team-skeleton)] motion-reduce:animate-none";

export type TeamStateTone = "info" | "success" | "warning" | "danger";

const TEAM_STATE_PANEL_CLASSES: Record<TeamStateTone, string> = {
  info: "border-[color:var(--team-info-border)] bg-[color:var(--team-info-surface)] text-[color:var(--team-info-text)]",
  success:
    "border-[color:var(--team-success-border)] bg-[color:var(--team-success-surface)] text-[color:var(--team-success-text)]",
  warning:
    "border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] text-[color:var(--team-warning-text)]",
  danger:
    "border-[color:var(--team-danger-border)] bg-[color:var(--team-danger-surface)] text-[color:var(--team-danger-text)]",
};

export function teamStatePanelClass(tone: TeamStateTone = "info"): string {
  return `rounded-2xl border p-4 text-sm ${TEAM_STATE_PANEL_CLASSES[tone]}`;
}
