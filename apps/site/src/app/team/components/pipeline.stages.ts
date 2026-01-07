export const PIPELINE_STAGES = ["new", "contacted", "quoted", "qualified", "won", "lost"] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  new: "New",
  contacted: "Contacted",
  quoted: "Quoted",
  qualified: "Booked",
  won: "Completed",
  lost: "Lost"
};

export type PipelineStageTheme = {
  dot: string;
  badge: string;
  cardBorder: string;
  cardBackground: string;
};

const DEFAULT_STAGE_THEME: PipelineStageTheme = {
  dot: "bg-slate-400",
  badge: "bg-slate-100 text-slate-600",
  cardBorder: "border-slate-200 hover:border-slate-300",
  cardBackground: "bg-white"
};

export const PIPELINE_STAGE_THEMES: Record<string, PipelineStageTheme> = {
  new: {
    dot: "bg-blue-400",
    badge: "bg-blue-100 text-blue-700",
    cardBorder: "border-blue-100 hover:border-blue-200",
    cardBackground: "bg-gradient-to-br from-white to-blue-50/60"
  },
  contacted: {
    dot: "bg-sky-400",
    badge: "bg-sky-100 text-sky-700",
    cardBorder: "border-sky-100 hover:border-sky-200",
    cardBackground: "bg-gradient-to-br from-white to-sky-50/60"
  },
  quoted: {
    dot: "bg-indigo-400",
    badge: "bg-indigo-100 text-indigo-700",
    cardBorder: "border-indigo-100 hover:border-indigo-200",
    cardBackground: "bg-gradient-to-br from-white to-indigo-50/60"
  },
  qualified: {
    dot: "bg-amber-400",
    badge: "bg-amber-100 text-amber-700",
    cardBorder: "border-amber-100 hover:border-amber-200",
    cardBackground: "bg-gradient-to-br from-white to-amber-50/60"
  },
  won: {
    dot: "bg-emerald-400",
    badge: "bg-emerald-100 text-emerald-700",
    cardBorder: "border-emerald-100 hover:border-emerald-200",
    cardBackground: "bg-gradient-to-br from-white to-emerald-50/60"
  },
  lost: {
    dot: "bg-rose-400",
    badge: "bg-rose-100 text-rose-700",
    cardBorder: "border-rose-100 hover:border-rose-200",
    cardBackground: "bg-gradient-to-br from-white to-rose-50/60"
  }
};

export function labelForPipelineStage(stage: string): string {
  return (PIPELINE_STAGE_LABELS as Record<string, string>)[stage] ?? stage;
}

export function themeForPipelineStage(stage: string): PipelineStageTheme {
  return PIPELINE_STAGE_THEMES[stage] ?? DEFAULT_STAGE_THEME;
}

export function badgeClassForPipelineStage(stage: string): string {
  switch (stage) {
    case "new":
      return "bg-primary-100 text-primary-700";
    case "contacted":
      return "bg-amber-100 text-amber-800";
    case "quoted":
      return "bg-indigo-100 text-indigo-800";
    case "qualified":
      return "bg-sky-100 text-sky-800";
    case "won":
      return "bg-emerald-100 text-emerald-800";
    case "lost":
      return "bg-rose-100 text-rose-800";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

