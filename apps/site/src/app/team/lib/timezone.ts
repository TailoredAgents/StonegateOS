// Compatibility exports for existing team surfaces. Calendar-specific date
// arithmetic lives in one DST-aware module so date-only navigation never
// advances by fixed 24-hour local-day assumptions.
export {
  TEAM_TIME_ZONE,
  formatCalendarDayKey as formatDayKey,
} from "./calendar-time";
