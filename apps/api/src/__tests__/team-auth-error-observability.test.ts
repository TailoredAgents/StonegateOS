import { describeTeamAuthInfrastructureError } from "@/lib/team-auth-error-observability";

describe("team authentication infrastructure-error observability", () => {
  it("keeps only validated outer and nested error classifications", () => {
    const cause = Object.assign(
      new Error("duplicate detail includes staff@example.com"),
      {
        name: "PostgresError",
        code: "42P10",
        detail: "private-password",
      },
    );
    const error = Object.assign(
      new Error(
        "Failed query: insert into team_auth_rate_limits; params: staff@example.com",
      ),
      {
        name: "DrizzleQueryError",
        query: "select private-password",
        params: ["staff@example.com"],
        cause,
      },
    );

    const description = describeTeamAuthInfrastructureError(error);

    expect(description).toEqual({
      errorName: "DrizzleQueryError",
      errorCode: null,
      causeName: "PostgresError",
      causeCode: "42P10",
    });
    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain("staff@example.com");
    expect(serialized).not.toContain("private-password");
    expect(serialized).not.toContain("Failed query");
  });

  it("does not log arbitrary thrown values or malformed classifications", () => {
    const error = {
      name: "Error with secret staff@example.com",
      code: "bad code; private-password",
      message: "staff@example.com",
      cause: {
        name: "Postgres Error",
        code: "42P10; DROP TABLE",
      },
    };

    expect(describeTeamAuthInfrastructureError(error)).toEqual({
      errorName: "UnknownError",
      errorCode: null,
      causeName: null,
      causeCode: null,
    });
    expect(describeTeamAuthInfrastructureError("staff@example.com")).toEqual({
      errorName: "UnknownError",
      errorCode: null,
      causeName: null,
      causeCode: null,
    });
  });
});
