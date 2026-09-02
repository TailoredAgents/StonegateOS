import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

// The Partner Portal lane runs as native ESM, where `__dirname` is absent.
// pnpm executes the filtered Jest command from the API package directory.
const workspaceRoot = resolve(process.cwd(), "../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

type WriterClassification =
  | "capacity_locked"
  | "same_capacity_lifecycle"
  | "metadata_only";

// This is deliberately exhaustive. A new Drizzle writer for an appointment,
// hold, or external schedule block must be classified here before it ships.
// The runbook contains the human-readable rationale for every exemption.
const WRITER_INVENTORY = {
  "apps/api/app/api/admin/booking/book/route.ts": "capacity_locked",
  "apps/api/app/api/appointments/[id]/convert/route.ts": "capacity_locked",
  "apps/api/app/api/appointments/[id]/final-total/route.ts": "metadata_only",
  "apps/api/app/api/appointments/[id]/manual-payments/route.ts":
    "metadata_only",
  "apps/api/app/api/appointments/[id]/notes/route.ts": "metadata_only",
  "apps/api/app/api/appointments/[id]/payment-attempts/route.ts":
    "metadata_only",
  "apps/api/app/api/appointments/[id]/route.ts": "metadata_only",
  "apps/api/app/api/appointments/[id]/sold-by/route.ts": "metadata_only",
  "apps/api/app/api/appointments/[id]/status/route.ts": "capacity_locked",
  "apps/api/app/api/junk-quote/book/route.ts": "capacity_locked",
  "apps/api/app/api/junk-quote/hold/route.ts": "capacity_locked",
  "apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts": "capacity_locked",
  "apps/api/app/api/web/appointments/[id]/reschedule/route.ts":
    "capacity_locked",
  "apps/api/app/api/web/lead-intake/route.ts": "capacity_locked",
  "apps/api/src/lib/appointment-media.ts": "metadata_only",
  "apps/api/src/lib/auto-replies.ts": "same_capacity_lifecycle",
  "apps/api/src/lib/calendar-sync.ts": "capacity_locked",
  "apps/api/src/lib/merge-queue.ts": "metadata_only",
  "apps/api/src/lib/outbox-processor.ts": "metadata_only",
  "apps/api/src/lib/partner-cancellation-request-lifecycle.ts":
    "capacity_locked",
  "apps/api/src/lib/partner-portal-v2-approvals.ts": "capacity_locked",
  "apps/api/src/lib/partner-portal-v2-scheduling/service.ts": "capacity_locked",
  "apps/api/src/lib/payment-ledger.ts": "metadata_only",
  "apps/api/src/lib/quote-scheduling.ts": "capacity_locked",
  "apps/api/src/lib/quote-v2-scheduling-service.ts": "capacity_locked",
  "apps/api/src/lib/quote-v2-staff-lifecycle.ts": "capacity_locked",
} as const satisfies Record<string, WriterClassification>;

type LockedBoundary = Readonly<{
  path: keyof typeof WRITER_INVENTORY;
  anchor: string;
  protectedOperation: string;
}>;

const LOCKED_BOUNDARIES: readonly LockedBoundary[] = [
  {
    path: "apps/api/app/api/admin/booking/book/route.ts",
    anchor: "const result = await db.transaction(async (tx) => {",
    protectedOperation: ".insert(appointments)",
  },
  {
    path: "apps/api/app/api/appointments/[id]/convert/route.ts",
    anchor: "const outcome = await database.transaction(async (tx) => {",
    protectedOperation: ".update(appointments)",
  },
  {
    path: "apps/api/app/api/appointments/[id]/status/route.ts",
    anchor: "const outcome = await database.transaction(async (tx) => {",
    protectedOperation: ".update(appointments)",
  },
  {
    path: "apps/api/app/api/junk-quote/book/route.ts",
    anchor: "const leadResult = await db.transaction(async (tx) => {",
    protectedOperation: ".insert(appointments)",
  },
  {
    path: "apps/api/app/api/junk-quote/hold/route.ts",
    anchor: "const holdResult = await db.transaction(async (tx) => {",
    protectedOperation: ".update(appointmentHolds)",
  },
  {
    path: "apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts",
    anchor: "const result = await db.transaction(async (tx) => {",
    protectedOperation: ".update(appointments)",
  },
  {
    path: "apps/api/app/api/web/appointments/[id]/reschedule/route.ts",
    anchor: ".transaction(async (tx) => {",
    protectedOperation: ".update(appointments)",
  },
  {
    path: "apps/api/app/api/web/lead-intake/route.ts",
    anchor: "const leadResult = await db.transaction(async (tx) => {",
    protectedOperation: ".insert(appointments)",
  },
  {
    path: "apps/api/src/lib/calendar-sync.ts",
    anchor: "const persisted = await db.transaction(async (tx) => {",
    protectedOperation: "applyEventsToAppointments(tx, events)",
  },
  {
    path: "apps/api/src/lib/partner-cancellation-request-lifecycle.ts",
    anchor: "export async function decidePartnerCancellationRequestAsStaff(",
    protectedOperation: ".update(appointments)",
  },
  {
    path: "apps/api/src/lib/partner-portal-v2-approvals.ts",
    anchor: "export async function decidePartnerApprovalRequest(",
    protectedOperation: "loadPartnerApprovalLifecycleContext({",
  },
  {
    path: "apps/api/src/lib/partner-portal-v2-scheduling/service.ts",
    anchor: "export async function updatePartnerBookingDraft(",
    protectedOperation: ".update(appointmentHolds)",
  },
  {
    path: "apps/api/src/lib/partner-portal-v2-scheduling/service.ts",
    anchor: "export async function createOrReplacePartnerHold(",
    protectedOperation: ".insert(appointmentHolds)",
  },
  {
    path: "apps/api/src/lib/partner-portal-v2-scheduling/service.ts",
    anchor: "export async function releasePartnerHold(",
    protectedOperation: ".update(appointmentHolds)",
  },
  {
    path: "apps/api/src/lib/partner-portal-v2-scheduling/service.ts",
    anchor: "export async function submitPartnerBookingDraft(",
    protectedOperation: ".insert(appointments)",
  },
  {
    path: "apps/api/src/lib/partner-portal-v2-scheduling/service.ts",
    anchor: "export async function reschedulePartnerBooking(",
    protectedOperation: ".update(appointments)",
  },
  {
    path: "apps/api/src/lib/quote-scheduling.ts",
    anchor: "export async function createQuoteAppointmentHold(",
    protectedOperation: ".insert(appointmentHolds)",
  },
  {
    path: "apps/api/src/lib/quote-scheduling.ts",
    anchor: "export async function bookAcceptedQuote(",
    protectedOperation: ".update(appointmentHolds)",
  },
  {
    path: "apps/api/src/lib/quote-v2-scheduling-service.ts",
    anchor: "export async function createQuoteV2AppointmentHold(",
    protectedOperation: ".insert(appointmentHolds)",
  },
  {
    path: "apps/api/src/lib/quote-v2-scheduling-service.ts",
    anchor: "export async function bookQuoteV2AcceptedResponse(",
    protectedOperation: ".insert(appointments)",
  },
  {
    path: "apps/api/src/lib/quote-v2-staff-lifecycle.ts",
    anchor: "export async function voidQuoteV2(",
    protectedOperation: ".update(appointmentHolds)",
  },
] as const;

function productionTypescriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...productionTypescriptFiles(path));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

describe("schedule writer inventory", () => {
  it("requires every production appointment, hold, and schedule-block writer to be classified", () => {
    const writerPattern =
      /\.(?:insert|update|delete)\(\s*(?:appointments|appointmentHolds|scheduleBlocks)\s*\)/u;
    const discovered = [
      ...productionTypescriptFiles(resolve(workspaceRoot, "apps/api/app")),
      ...productionTypescriptFiles(resolve(workspaceRoot, "apps/api/src/lib")),
    ]
      .filter((path) => writerPattern.test(readFileSync(path, "utf8")))
      .map((path) => relative(workspaceRoot, path))
      .sort();

    expect(discovered).toEqual(Object.keys(WRITER_INVENTORY).sort());
  });

  it("rejects unclassified raw SQL schedule-table mutations", () => {
    const rawScheduleMutation =
      /(?:insert\s+into|update|delete\s+from)\s+"?\s*(?:appointments|appointment_holds|schedule_blocks)\b/iu;
    const discovered = [
      ...productionTypescriptFiles(resolve(workspaceRoot, "apps/api/app")),
      ...productionTypescriptFiles(resolve(workspaceRoot, "apps/api/src/lib")),
    ]
      .filter((path) => rawScheduleMutation.test(readFileSync(path, "utf8")))
      .map((path) => relative(workspaceRoot, path))
      .sort();

    expect(discovered).toEqual([]);
  });

  it.each(LOCKED_BOUNDARIES)(
    "$path takes the shared lock before $protectedOperation",
    ({ path, anchor, protectedOperation }) => {
      const source = read(path);
      const anchorIndex = source.indexOf(anchor);
      const lockIndex = source.indexOf(
        "acquireScheduleConflictLock(tx)",
        anchorIndex,
      );
      const operationIndex = source.indexOf(protectedOperation, anchorIndex);

      expect(anchorIndex).toBeGreaterThanOrEqual(0);
      expect(lockIndex).toBeGreaterThan(anchorIndex);
      expect(operationIndex).toBeGreaterThan(lockIndex);
    },
  );

  it("keeps the only unlocked status automation within the blocking-status set", () => {
    const source = read("apps/api/src/lib/auto-replies.ts");
    expect(source).toContain('.set({ status: "confirmed", updatedAt: now })');
    expect(source).toContain(
      '.set({ status: "requested", updatedAt: now, calendarEventId: null })',
    );
    expect(source).not.toMatch(
      /\.set\(\{[^}]*status:\s*"(?:canceled|completed|no_show)"/su,
    );
  });
});
