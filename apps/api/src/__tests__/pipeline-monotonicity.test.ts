import { canAutomaticallyTransitionPipeline } from "@/lib/pipeline-monotonicity";

describe("pipeline automatic transition monotonicity", () => {
  it("never reopens a won or lost pipeline", () => {
    expect(canAutomaticallyTransitionPipeline("won", "quoted")).toBe(false);
    expect(canAutomaticallyTransitionPipeline("lost", "qualified")).toBe(false);
    expect(canAutomaticallyTransitionPipeline("won", "lost")).toBe(false);
  });

  it("allows open-stage progression and an initial stage", () => {
    expect(canAutomaticallyTransitionPipeline(null, "new")).toBe(true);
    expect(canAutomaticallyTransitionPipeline("new", "quoted")).toBe(true);
    expect(canAutomaticallyTransitionPipeline("quoted", "won")).toBe(true);
    expect(canAutomaticallyTransitionPipeline("quoted", "quoted")).toBe(false);
  });
});
