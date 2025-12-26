export const CONVERSATION_STATES = [
  "new",
  "qualifying",
  "photos_received",
  "estimated",
  "offered_times",
  "booked",
  "reminder",
  "completed",
  "review"
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

export function isConversationState(value: string | null): value is ConversationState {
  return value ? (CONVERSATION_STATES as readonly string[]).includes(value) : false;
}

export function getConversationStateIndex(state: ConversationState): number {
  return CONVERSATION_STATES.indexOf(state);
}

export function canTransitionConversationState(
  current: ConversationState,
  next: ConversationState,
  options?: { allowBackward?: boolean }
): boolean {
  if (current === next) {
    return true;
  }

  if (options?.allowBackward) {
    return true;
  }

  const currentIndex = getConversationStateIndex(current);
  const nextIndex = getConversationStateIndex(next);

  if (currentIndex === -1 || nextIndex === -1) {
    return false;
  }

  return nextIndex >= currentIndex;
}

export function getAllowedConversationStates(
  current: ConversationState,
  options?: { allowBackward?: boolean }
): ConversationState[] {
  if (options?.allowBackward) {
    return [...CONVERSATION_STATES];
  }

  const currentIndex = getConversationStateIndex(current);
  if (currentIndex === -1) {
    return [...CONVERSATION_STATES];
  }

  return CONVERSATION_STATES.slice(currentIndex);
}
