import type { PipelineContact, PipelineLane } from "./pipeline.types";

export function sortPipelineContacts(
  contacts: readonly PipelineContact[],
): PipelineContact[] {
  return [...contacts].sort((left, right) => {
    const leftTime = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
    const rightTime = right.lastActivityAt
      ? Date.parse(right.lastActivityAt)
      : 0;
    return rightTime - leftTime || left.id.localeCompare(right.id);
  });
}

export function normalizePipelineBoard(
  lanes: readonly PipelineLane[],
): PipelineLane[] {
  return lanes.map((lane) => ({
    stage: lane.stage,
    contacts: sortPipelineContacts(lane.contacts),
  }));
}

export function findPipelineContact(
  lanes: readonly PipelineLane[],
  contactId: string,
): PipelineContact | null {
  for (const lane of lanes) {
    const contact = lane.contacts.find(
      (candidate) => candidate.id === contactId,
    );
    if (contact) return contact;
  }
  return null;
}

/**
 * Moves exactly one contact while retaining every other lane entry. Passing the
 * server's timestamp after a save or conflict keeps the next compare-and-set
 * request tied to the version the user can actually see.
 */
export function movePipelineContact(
  lanes: readonly PipelineLane[],
  contactId: string,
  targetStage: string,
  updatedAt: string | null,
): PipelineLane[] {
  const existing = findPipelineContact(lanes, contactId);
  if (!existing || !lanes.some((lane) => lane.stage === targetStage)) {
    return lanes.map((lane) => ({
      ...lane,
      contacts: [...lane.contacts],
    }));
  }

  const moved: PipelineContact = {
    ...existing,
    pipeline: {
      ...existing.pipeline,
      stage: targetStage,
      updatedAt,
    },
  };

  return lanes.map((lane) => {
    const contacts = lane.contacts.filter(
      (contact) => contact.id !== contactId,
    );
    return {
      ...lane,
      contacts:
        lane.stage === targetStage
          ? sortPipelineContacts([...contacts, moved])
          : contacts,
    };
  });
}
