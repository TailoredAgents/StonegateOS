import { hasMobilePermission } from "../../../site/src/app/mobile/lib/permission-matching";

describe("mobile site permission matching", () => {
  it("does not treat generic read as permission to view payment data", () => {
    expect(hasMobilePermission(["read"], "payments.read")).toBe(false);
    expect(hasMobilePermission(["read"], "appointments.read")).toBe(true);
    expect(
      hasMobilePermission(["payments.read"], "payments.read"),
    ).toBe(true);
  });
});
