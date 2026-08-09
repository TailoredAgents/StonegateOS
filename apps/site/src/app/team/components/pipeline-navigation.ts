import { teamSurfaceHref } from "../surface-registry";
import type { PipelineView } from "./pipeline.types";

export type PipelineHrefState = {
  q: string;
  stage: string | null;
  offset: number;
  view: PipelineView;
  excludeOutbound: boolean;
  contactId?: string | null;
};

export function buildPipelineHref(state: PipelineHrefState) {
  return teamSurfaceHref("pipeline", {
    query: {
      q: state.q || undefined,
      stage: state.stage || undefined,
      offset: state.offset > 0 ? state.offset : undefined,
      view: state.view === "list" ? "list" : undefined,
      outbound: state.excludeOutbound ? undefined : "include",
      contactId: state.contactId || undefined,
    },
  });
}
