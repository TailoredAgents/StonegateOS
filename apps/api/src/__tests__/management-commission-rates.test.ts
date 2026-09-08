import { validateManagementRateVersion } from "@/lib/management-commission-rates";

describe("effective management rate validation", () => {
  it("allows a zero recipient and a five-percent sole paid recipient", () => {
    expect(() =>
      validateManagementRateVersion(500, [
        { memberId: "austin", rateBps: 0 },
        { memberId: "jeffrey", rateBps: 500 },
      ]),
    ).not.toThrow();
  });
  it("rejects inconsistent totals, duplicate members, and unsafe rates", () => {
    for (const [total, recipients] of [
      [1700, [{ memberId: "jeffrey", rateBps: 500 }]],
      [
        500,
        [
          { memberId: "jeffrey", rateBps: 250 },
          { memberId: "jeffrey", rateBps: 250 },
        ],
      ],
      [-1, [{ memberId: "jeffrey", rateBps: -1 }]],
      [500.5, [{ memberId: "jeffrey", rateBps: 500.5 }]],
      [10001, [{ memberId: "jeffrey", rateBps: 10001 }]],
      [0, []],
    ] as const)
      expect(() => validateManagementRateVersion(total, recipients)).toThrow(
        "invalid_management_rate_version",
      );
  });
});
