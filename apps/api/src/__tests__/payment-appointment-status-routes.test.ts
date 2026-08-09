import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canCollectAppointmentPayment } from "@/lib/payment-ledger";

const workspaceRoot = resolve(__dirname, "../../../..");
const squareRoute = readFileSync(
  resolve(
    workspaceRoot,
    "apps/api/app/api/appointments/[id]/payment-attempts/route.ts",
  ),
  "utf8",
);
const manualRoute = readFileSync(
  resolve(
    workspaceRoot,
    "apps/api/app/api/appointments/[id]/manual-payments/route.ts",
  ),
  "utf8",
);

describe("payment collection appointment-status boundary", () => {
  it.each(["canceled", "no_show"])(
    "rejects collection for a %s appointment",
    (status) => {
      expect(canCollectAppointmentPayment(status, "junk_removal")).toBe(false);
    },
  );

  it.each(["in_person_quote", "in_person_estimate"])(
    "rejects collection for a %s appointment type",
    (type) => {
      expect(canCollectAppointmentPayment("confirmed", type)).toBe(false);
    },
  );

  it.each(["requested", "confirmed", "completed"])(
    "keeps a normal %s job collectible when its locked ledger is safe",
    (status) => {
      expect(canCollectAppointmentPayment(status, "junk_removal")).toBe(true);
    },
  );

  it.each([
    ["Square", squareRoute],
    ["manual", manualRoute],
  ])(
    "checks the locked %s appointment state inside the transaction",
    (_name, source) => {
      const transaction = source.indexOf("database.transaction(async (tx)");
      const appointmentLock = source.indexOf('.for("update")', transaction);
      const collectible = source.indexOf(
        "canCollectAppointmentPayment(appointment.status, appointment.type)",
        appointmentLock,
      );
      const scope = source.indexOf(
        "getAppointmentScopeState(appointmentId, tx)",
        collectible,
      );

      expect(transaction).toBeGreaterThan(0);
      expect(appointmentLock).toBeGreaterThan(transaction);
      expect(collectible).toBeGreaterThan(appointmentLock);
      expect(scope).toBeGreaterThan(collectible);
      expect(source).toContain("completeAppointmentPaymentFailure(");
      expect(source).toContain("This appointment is not collectible.");
    },
  );
});
