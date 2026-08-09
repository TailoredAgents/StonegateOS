import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readQuietHoursChannel } from "../../../../tests/e2e/audit/policy-evidence";

const JOURNEY = readFileSync(
  join(process.cwd(), "../../tests/e2e/audit/team-console-audit.spec.ts"),
  "utf8",
);

describe("Policy Center runtime evidence", () => {
  it("extracts only a complete channel window from the persisted policy", () => {
    expect(
      readQuietHoursChannel(
        {
          channels: {
            sms: { start: "21:00", end: "08:30" },
          },
        },
        "sms",
      ),
    ).toEqual({ start: "21:00", end: "08:30" });
    expect(readQuietHoursChannel(null, "sms")).toBeNull();
    expect(
      readQuietHoursChannel({ channels: { sms: { end: "08:30" } } }, "sms"),
    ).toBeNull();
    expect(readQuietHoursChannel({ channels: { sms: [] } }, "sms")).toBeNull();
  });

  it("waits for the confirmed Site receipt before polling the exact DB field", () => {
    expect(JOURNEY).toContain(
      'page.getByText("Quiet hours updated", { exact: true })',
    );
    expect(JOURNEY).toContain(
      '.poll(async () => (await getQuietHoursChannel("sms"))?.end ?? null)',
    );
    expect(JOURNEY).not.toContain(
      ".toMatchObject({ quietHours: expect.any(Object) })",
    );
    expect(JOURNEY).not.toContain(".then(() => getSettingValues())");
  });
});
