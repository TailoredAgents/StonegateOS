export const PIPELINE_STAGES = ["new", "contacted", "quoted", "in_person_quote", "qualified", "won", "lost"] as const;

export const PIPELINE_STAGE_SET = new Set<string>(PIPELINE_STAGES);

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
