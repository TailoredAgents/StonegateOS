export const CLOSED_PIPELINE_STAGES = new Set(["won", "lost"]);

export function canAutomaticallyTransitionPipeline(
  previousStage: string | null,
  targetStage: string,
): boolean {
  if (previousStage === targetStage) return false;
  return !previousStage || !CLOSED_PIPELINE_STAGES.has(previousStage);
}
