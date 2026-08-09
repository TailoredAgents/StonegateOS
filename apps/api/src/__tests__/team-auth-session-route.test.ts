import type { NextRequest } from "next/server";

type SessionResult = {
  ok: true;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
  teamMember: Record<string, unknown>;
};

const mockRequireTeamSession = jest.fn<Promise<SessionResult>, [NextRequest]>();

jest.mock("@/lib/team-auth", () => ({
  requireTeamSession: mockRequireTeamSession,
}));

import { GET } from "../../app/api/public/team/session/route";

describe("public team session route", () => {
  it("exposes verified session metadata but not the bearer token or hash", async () => {
    mockRequireTeamSession.mockResolvedValue({
      ok: true,
      sessionId: "session-1",
      authMethod: "team_session",
      teamMember: {
        id: "member-1",
        name: "Staff Member",
        email: "staff@example.com",
        roleSlug: "office",
        passwordSet: true,
        permissions: ["contacts.read"],
      },
    });
    const request = {
      headers: new Headers({ authorization: "Bearer secret-session-token" }),
    } as NextRequest;

    const response = await GET(request);
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        sessionId: "session-1",
        authMethod: "team_session",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("secret-session-token");
    expect(JSON.stringify(body)).not.toContain("sessionHash");
  });
});
