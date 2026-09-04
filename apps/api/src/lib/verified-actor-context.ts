import type { NextRequest } from "next/server";

export type VerifiedRequestActor = {
  type: "human" | "ai" | "system" | "worker";
  id?: string | null;
  role?: string | null;
  label?: string | null;
  sessionId?: string | null;
  authMethod: "team_session" | "break_glass" | "service";
  /** Server-derived session creation time; never accepted from actor headers. */
  authenticatedAt?: string | null;
};

const verifiedActors = new WeakMap<object, VerifiedRequestActor>();

export function setVerifiedRequestActor(
  request: NextRequest,
  actor: VerifiedRequestActor,
): void {
  verifiedActors.set(request, actor);
}

export function getVerifiedRequestActor(
  request: NextRequest,
): VerifiedRequestActor | null {
  return verifiedActors.get(request) ?? null;
}
