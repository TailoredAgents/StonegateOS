import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_PARTNER_ACCOUNT_SCHEDULING_POLICY,
  narrowGlobalPartnerSchedulingPolicy,
  validatePartnerAccountSchedulingPolicy,
} from "@/lib/partner-account-scheduling-policy";
import { computePartnerAvailability } from "@/lib/partner-portal-v2-scheduling/domain";
import {
  createScheduleDemand,
  createSchedulePolicySnapshot,
} from "@/lib/scheduling";

const schedulingServiceSource = readFileSync(
  resolve(process.cwd(), "src/lib/partner-portal-v2-scheduling/service.ts"),
  "utf8",
);
const routeSource = readFileSync(
  resolve(
    process.cwd(),
    "app/api/admin/partner-management/v1/accounts/[accountId]/scheduling-policy/route.ts",
  ),
  "utf8",
);
const migrationSource = readFileSync(
  resolve(
    process.cwd(),
    "src/db/migrations/0147_partner_account_scheduling_policy.sql",
  ),
  "utf8",
);
const staffActionSource = readFileSync(
  resolve(
    process.cwd(),
    "../site/src/app/team/actions/partner-administration.ts",
  ),
  "utf8",
);
const staffUiSource = readFileSync(
  resolve(
    process.cwd(),
    "../site/src/app/team/components/PartnerAdministrationSection.tsx",
  ),
  "utf8",
);

describe("Partner account scheduling narrowing policy", () => {
  it("uses max/max/min/AND so an account can never widen global policy", () => {
    const effective = narrowGlobalPartnerSchedulingPolicy({
      global: {
        minimumNoticeMinutes: 180,
        minimumCalendarLeadDays: 3,
        maximumBookingHorizonDays: 14,
        instantConfirmationEnabled: false,
      },
      account: {
        minimumNoticeMinutes: 60,
        minimumCalendarLeadDays: 1,
        maximumBookingHorizonDays: 30,
        instantConfirmationEnabled: true,
      },
    });
    expect(effective).toEqual({
      minimumNoticeMinutes: 180,
      minimumCalendarLeadDays: 3,
      maximumBookingHorizonDays: 14,
      instantConfirmationEnabled: false,
    });
    expect(effective).not.toHaveProperty("weeklyHours");
    expect(effective).not.toHaveProperty("capacityUnits");
  });

  it("applies every stricter account limit and fails closed without a row", () => {
    expect(
      narrowGlobalPartnerSchedulingPolicy({
        global: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 1,
          maximumBookingHorizonDays: 30,
          instantConfirmationEnabled: true,
        },
        account: {
          minimumNoticeMinutes: 1_440,
          minimumCalendarLeadDays: 4,
          maximumBookingHorizonDays: 7,
          instantConfirmationEnabled: false,
        },
      }),
    ).toEqual({
      minimumNoticeMinutes: 1_440,
      minimumCalendarLeadDays: 4,
      maximumBookingHorizonDays: 7,
      instantConfirmationEnabled: false,
    });
    expect(
      narrowGlobalPartnerSchedulingPolicy({
        global: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 1,
          maximumBookingHorizonDays: 30,
          instantConfirmationEnabled: true,
        },
        account: null,
      }).instantConfirmationEnabled,
    ).toBe(false);
    expect(Object.isFrozen(DEFAULT_PARTNER_ACCOUNT_SCHEDULING_POLICY)).toBe(
      true,
    );
  });

  it.each([
    {
      minimumNoticeMinutes: -1,
      minimumCalendarLeadDays: 1,
      maximumBookingHorizonDays: 30,
      instantConfirmationEnabled: false,
    },
    {
      minimumNoticeMinutes: 0,
      minimumCalendarLeadDays: 0,
      maximumBookingHorizonDays: 30,
      instantConfirmationEnabled: false,
    },
    {
      minimumNoticeMinutes: 0,
      minimumCalendarLeadDays: 1,
      maximumBookingHorizonDays: 31,
      instantConfirmationEnabled: false,
    },
  ])("rejects out-of-contract account policy %#", (policy) => {
    expect(() => validatePartnerAccountSchedulingPolicy(policy)).toThrow(
      TypeError,
    );
  });

  it("feeds narrowed lead and horizon values into actual Partner candidate generation", () => {
    const effective = narrowGlobalPartnerSchedulingPolicy({
      global: {
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 1,
        maximumBookingHorizonDays: 30,
        instantConfirmationEnabled: true,
      },
      account: {
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 3,
        maximumBookingHorizonDays: 5,
        instantConfirmationEnabled: true,
      },
    });
    const hours = [{ startMinute: 8 * 60, endMinute: 17 * 60 }];
    const policy = createSchedulePolicySnapshot({
      revision: "account-policy-v1",
      timezone: "UTC",
      slotIntervalMinutes: 30,
      partnerWindowMinutes: 120,
      holdTtlMinutes: 10,
      bookingWindowDays: effective.maximumBookingHorizonDays,
      defaultTravelBufferMinutes: 30,
      maxJobsPerDay: 0,
      maxJobsPerCrew: 0,
      weeklyHours: {
        monday: hours,
        tuesday: hours,
        wednesday: hours,
        thursday: hours,
        friday: hours,
        saturday: hours,
        sunday: hours,
      },
      dateOverrides: [],
      capacityPools: {
        field_service: { key: "field_service", capacityUnits: 2 },
      },
      channels: {
        partner_portal: {
          minimumNoticeMinutes: effective.minimumNoticeMinutes,
          minimumCalendarLeadDays: effective.minimumCalendarLeadDays,
          allowsInstantConfirmation: effective.instantConfirmationEnabled,
        },
        public_quote: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
        instant_quote: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
        staff: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
        autonomous: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
      },
    });
    const result = computePartnerAvailability({
      policy,
      demand: createScheduleDemand({
        serviceKey: "junk-removal",
        durationMinutes: 60,
        travelBufferMinutes: 30,
        capacityPoolKey: "field_service",
        capacityUnits: 1,
      }),
      blocks: [],
      rangeStartAt: new Date("2026-09-01T00:00:00.000Z"),
      rangeEndAt: new Date("2026-09-10T23:59:59.999Z"),
      now: new Date("2026-09-01T12:00:00.000Z"),
    });
    const availableDates = new Set(
      result.candidates
        .filter((candidate) => candidate.available)
        .map((candidate) => candidate.localDate),
    );
    expect([...availableDates].sort()).toEqual([
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
  });

  it("loads account policy into availability/confirmation and hashes it into the schedule revision", () => {
    expect(schedulingServiceSource).toContain(
      ".from(partnerAccountSchedulingPolicies)",
    );
    expect(schedulingServiceSource).toContain(
      "narrowGlobalPartnerSchedulingPolicy",
    );
    expect(schedulingServiceSource).toContain(
      "minimumNoticeMinutes: effectiveAccountPolicy.minimumNoticeMinutes",
    );
    expect(schedulingServiceSource).toContain(
      "bookingWindowDays: effectiveAccountPolicy.maximumBookingHorizonDays",
    );
    expect(schedulingServiceSource).toContain(
      "effectiveAccountPolicy.instantConfirmationEnabled",
    );
    expect(schedulingServiceSource).toMatch(
      /accountPolicy:[\s\S]{0,900}revision: accountPolicy\.revision/u,
    );
  });

  it("exposes one guarded, idempotent, recent-authenticated staff writer", () => {
    expect(routeSource).toContain(
      'requiredPermissions: ["partners.accounts.manage"]',
    );
    expect(routeSource).toContain('risk: "external"');
    expect(routeSource).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    expect(routeSource).toContain("claimTeamMutationIdempotency");
    expect(routeSource).toContain("mutation.audit.insertSuccess");
    expect(routeSource).toContain(
      "updatePartnerAccountSchedulingPolicyAsStaff",
    );
    expect(staffActionSource).toContain("partnerAccountSchedulingPolicyAction");
    expect(staffUiSource).toContain("Configure Partner scheduling limits");
    expect(staffUiSource).toMatch(
      /They\s+never\s+expand\s+Stonegate\s+hours\s+or\s+capacity/u,
    );
  });

  it("backfills and trigger-seeds a fail-closed policy with database bounds", () => {
    expect(migrationSource).toContain(
      'CREATE TABLE "partner_account_scheduling_policies"',
    );
    expect(migrationSource).toContain(
      '"instant_confirmation_enabled" boolean NOT NULL DEFAULT false',
    );
    expect(migrationSource).toContain(
      'CREATE TRIGGER "partner_accounts_seed_scheduling_policy"',
    );
    expect(migrationSource).toContain(
      'CHECK ("maximum_booking_horizon_days" BETWEEN 1 AND 30)',
    );
  });
});
