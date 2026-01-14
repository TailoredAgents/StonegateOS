import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, policySettings } from "@/db";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export type ServiceAreaPolicy = {
  mode: "zip_allowlist";
  homeBase?: string;
  radiusMiles?: number;
  zipAllowlist: string[];
  notes?: string;
};

export type TimeWindow = {
  start: string;
  end: string;
};

export type WeekdayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type BusinessHoursPolicy = {
  timezone: string;
  weekly: Record<WeekdayKey, TimeWindow[]>;
};

export type QuietHoursPolicy = {
  channels: Record<string, TimeWindow>;
};

export type TemplateGroup = Record<string, string>;
export type TemplatesPolicy = {
  first_touch: TemplateGroup;
  follow_up: TemplateGroup;
  confirmations: TemplateGroup;
  reviews: TemplateGroup;
  out_of_area: TemplateGroup;
};

export type CompanyProfilePolicy = {
  businessName: string;
  primaryPhone: string;
  serviceAreaSummary: string;
  trailerAndPricingSummary: string;
  whatWeDo: string;
  whatWeDontDo: string;
  bookingStyle: string;
  agentNotes: string;
};

export type BookingRulesPolicy = {
  bookingWindowDays: number;
  bufferMinutes: number;
  maxJobsPerDay: number;
  maxJobsPerCrew: number;
};

export type StandardJobPolicy = {
  allowedServices: string[];
  maxVolumeCubicYards: number;
  maxItemCount: number;
  notes?: string;
};

export type ItemPoliciesPolicy = {
  declined: string[];
  extraFees: Array<{ item: string; fee: number }>;
};

export type ConfirmationLoopPolicy = {
  enabled: boolean;
  windowsMinutes: number[];
};

export type FollowUpSequencePolicy = {
  enabled: boolean;
  stepsMinutes: number[];
};

export type SalesAutopilotPolicy = {
  enabled: boolean;
  autoSendAfterMinutes: number;
  activityWindowMinutes: number;
  retryDelayMinutes: number;
  agentDisplayName: string;
};

const DEFAULT_POLICY_TIMEZONE = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";

const WEEKDAY_KEYS: WeekdayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
];

export const DEFAULT_BUSINESS_HOURS_POLICY: BusinessHoursPolicy = {
  timezone: DEFAULT_POLICY_TIMEZONE,
  weekly: {
    monday: [{ start: "08:00", end: "18:00" }],
    tuesday: [{ start: "08:00", end: "18:00" }],
    wednesday: [{ start: "08:00", end: "18:00" }],
    thursday: [{ start: "08:00", end: "18:00" }],
    friday: [{ start: "08:00", end: "18:00" }],
    saturday: [{ start: "09:00", end: "14:00" }],
    sunday: []
  }
};

export const DEFAULT_QUIET_HOURS_POLICY: QuietHoursPolicy = {
  channels: {
    sms: { start: "20:00", end: "08:00" },
    email: { start: "19:00", end: "07:00" },
    dm: { start: "20:00", end: "08:00" }
  }
};

export const DEFAULT_COMPANY_PROFILE_POLICY: CompanyProfilePolicy = {
  businessName: "Stonegate Junk Removal",
  primaryPhone: "(404) 777-2631",
  serviceAreaSummary: "North Metro Atlanta within about 50 miles of Woodstock, Georgia (ZIP allowlist).",
  trailerAndPricingSummary:
    "We use a 7x16x4 dump trailer. Pricing is strictly based on trailer volume in quarter trailer increments. Photos help us estimate quickly.",
  whatWeDo: "Junk removal and hauling for household and light commercial items.",
  whatWeDontDo: "We do not service out of area locations. We do not take hazmat, oils, or paints. Ask if unsure.",
  bookingStyle:
    "Offer 2 concrete options and move to booking. Ask for ZIP, item details, and preferred timing. If photos are available, request them.",
  agentNotes: "Keep replies short, friendly, and human. Avoid lists and avoid dash characters. No links."
};

export const DEFAULT_SALES_AUTOPILOT_POLICY: SalesAutopilotPolicy = {
  enabled: true,
  autoSendAfterMinutes: 15,
  activityWindowMinutes: 14,
  retryDelayMinutes: 2,
  agentDisplayName: "Devon"
};

export const DEFAULT_SERVICE_AREA_POLICY: ServiceAreaPolicy = {
  mode: "zip_allowlist",
  homeBase: "Woodstock, GA",
  radiusMiles: 50,
  zipAllowlist: [
    "30002",
    "30003",
    "30004",
    "30005",
    "30006",
    "30007",
    "30008",
    "30009",
    "30010",
    "30011",
    "30012",
    "30013",
    "30017",
    "30018",
    "30019",
    "30021",
    "30022",
    "30023",
    "30024",
    "30026",
    "30028",
    "30029",
    "30030",
    "30031",
    "30032",
    "30033",
    "30034",
    "30035",
    "30036",
    "30037",
    "30038",
    "30039",
    "30040",
    "30041",
    "30042",
    "30043",
    "30044",
    "30045",
    "30046",
    "30047",
    "30048",
    "30052",
    "30054",
    "30058",
    "30060",
    "30061",
    "30062",
    "30063",
    "30064",
    "30065",
    "30066",
    "30067",
    "30068",
    "30069",
    "30071",
    "30072",
    "30074",
    "30075",
    "30076",
    "30077",
    "30078",
    "30079",
    "30080",
    "30081",
    "30082",
    "30083",
    "30084",
    "30085",
    "30086",
    "30087",
    "30088",
    "30090",
    "30091",
    "30092",
    "30093",
    "30094",
    "30095",
    "30096",
    "30097",
    "30098",
    "30099",
    "30101",
    "30102",
    "30103",
    "30104",
    "30105",
    "30106",
    "30107",
    "30108",
    "30109",
    "30110",
    "30111",
    "30113",
    "30114",
    "30115",
    "30116",
    "30117",
    "30118",
    "30119",
    "30120",
    "30121",
    "30122",
    "30123",
    "30124",
    "30125",
    "30126",
    "30127",
    "30129",
    "30132",
    "30133",
    "30134",
    "30135",
    "30137",
    "30138",
    "30139",
    "30140",
    "30141",
    "30142",
    "30143",
    "30144",
    "30145",
    "30146",
    "30147",
    "30148",
    "30149",
    "30150",
    "30151",
    "30152",
    "30153",
    "30154",
    "30157",
    "30161",
    "30162",
    "30163",
    "30164",
    "30165",
    "30168",
    "30171",
    "30172",
    "30173",
    "30175",
    "30176",
    "30177",
    "30178",
    "30179",
    "30180",
    "30183",
    "30184",
    "30185",
    "30187",
    "30188",
    "30189",
    "30213",
    "30214",
    "30215",
    "30228",
    "30232",
    "30236",
    "30237",
    "30238",
    "30250",
    "30253",
    "30260",
    "30265",
    "30268",
    "30269",
    "30272",
    "30273",
    "30274",
    "30281",
    "30287",
    "30288",
    "30290",
    "30291",
    "30294",
    "30296",
    "30297",
    "30298",
    "30301",
    "30302",
    "30303",
    "30304",
    "30305",
    "30306",
    "30307",
    "30308",
    "30309",
    "30310",
    "30311",
    "30312",
    "30313",
    "30314",
    "30315",
    "30316",
    "30317",
    "30318",
    "30319",
    "30320",
    "30321",
    "30322",
    "30324",
    "30325",
    "30326",
    "30327",
    "30328",
    "30329",
    "30330",
    "30331",
    "30332",
    "30333",
    "30334",
    "30336",
    "30337",
    "30338",
    "30339",
    "30340",
    "30341",
    "30342",
    "30343",
    "30344",
    "30345",
    "30346",
    "30347",
    "30348",
    "30349",
    "30350",
    "30353",
    "30354",
    "30355",
    "30356",
    "30357",
    "30358",
    "30359",
    "30360",
    "30361",
    "30362",
    "30364",
    "30366",
    "30368",
    "30369",
    "30370",
    "30371",
    "30374",
    "30375",
    "30376",
    "30377",
    "30378",
    "30379",
    "30380",
    "30384",
    "30385",
    "30386",
    "30387",
    "30388",
    "30389",
    "30390",
    "30392",
    "30394",
    "30396",
    "30398",
    "30399",
    "30501",
    "30502",
    "30503",
    "30504",
    "30506",
    "30507",
    "30515",
    "30517",
    "30518",
    "30519",
    "30522",
    "30527",
    "30533",
    "30534",
    "30539",
    "30540",
    "30542",
    "30543",
    "30548",
    "30564",
    "30566",
    "30575",
    "30597",
    "30620",
    "30656",
    "30680",
    "30701",
    "30703",
    "30705",
    "30724",
    "30732",
    "30733",
    "30734",
    "30735",
    "30746",
    "31106",
    "31107",
    "31119",
    "31126",
    "31131",
    "31139",
    "31141",
    "31145",
    "31146",
    "31150",
    "31156",
    "31191",
    "31192",
    "31193",
    "31195",
    "31196",
    "31197",
    "31198",
    "31199"
  ],
  notes: "Allowlist by ZIP (50 miles from Woodstock)."
};

export const DEFAULT_BOOKING_RULES_POLICY: BookingRulesPolicy = {
  bookingWindowDays: 30,
  bufferMinutes: 30,
  maxJobsPerDay: 6,
  maxJobsPerCrew: 3
};

export const DEFAULT_CONFIRMATION_LOOP_POLICY: ConfirmationLoopPolicy = {
  enabled: false,
  windowsMinutes: [24 * 60, 2 * 60]
};

export const DEFAULT_FOLLOW_UP_SEQUENCE_POLICY: FollowUpSequencePolicy = {
  enabled: true,
  stepsMinutes: [24 * 60, 72 * 60, 7 * 24 * 60]
};

export const DEFAULT_STANDARD_JOB_POLICY: StandardJobPolicy = {
  allowedServices: ["junk_removal_primary"],
  maxVolumeCubicYards: 12,
  maxItemCount: 20,
  notes: "Standard jobs only. Oversize/hazard items require approval."
};

export const DEFAULT_ITEM_POLICIES: ItemPoliciesPolicy = {
  declined: ["hazmat", "paint", "oil"],
  extraFees: [{ item: "mattress", fee: 25 }]
};

export const DEFAULT_TEMPLATES_POLICY: TemplatesPolicy = {
  first_touch: {
    sms: "Hey this is Devon, with Stonegate Junk Removal. What all do you need removed and when would you like us to come out? If you can, send a couple photos and your zip code.",
    email:
      "Thanks for contacting Stonegate Junk Removal. This is Devon. What items do you need removed and what timeframe are you aiming for? If you have photos and your zip code, include those and we will follow up.",
    dm: "Hey this is Devon, with Stonegate Junk Removal. What all do you need removed and what zip code? Photos help too.",
    call: "Sorry we missed you. This is Devon with Stonegate Junk Removal. Text back what you need removed, your zip code, and photos if you have them. We will get you scheduled.",
    web: "Hey this is Devon, with Stonegate Junk Removal. What all do you need removed and what zip code? Photos help too."
  },
  follow_up: {
    sms: "Just checking in. Do you want to lock in a time for your junk removal?",
    email: "Following up on your quote request. Let us know if you want to schedule."
  },
  confirmations: {
    sms: "Confirmed! We will see you at the scheduled time. Reply YES to confirm.",
    email: "Your appointment is confirmed. Reply YES if everything looks right."
  },
  reviews: {
    sms: "Thanks for choosing Stonegate! Would you leave a quick review?",
    email: "We appreciate your business. If you have a moment, please share a review."
  },
  out_of_area: {
    sms: "Thanks for reaching out! We currently serve areas within 50 miles of Woodstock. If you are just outside, call (404) 777-2631 and we will try to help.",
    email: "Thanks for reaching out! We currently serve areas within 50 miles of Woodstock. If you are just outside our zone, call (404) 777-2631 and we will try to help.",
    web: "Thanks for reaching out! We currently serve areas within 50 miles of Woodstock. If you are just outside our zone, call (404) 777-2631 and we will try to help."
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTimeString(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function coerceTimeWindow(value: unknown): TimeWindow | null {
  if (!isRecord(value)) return null;
  const start = parseTimeString(value["start"]);
  const end = parseTimeString(value["end"]);
  if (!start || !end) return null;
  const startText = `${String(start.hour).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}`;
  const endText = `${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}`;
  return { start: startText, end: endText };
}

function coerceTimeWindowList(value: unknown, fallback: TimeWindow[]): TimeWindow[] {
  if (!Array.isArray(value)) return fallback;
  return value.map(coerceTimeWindow).filter((entry): entry is TimeWindow => Boolean(entry));
}

function resolveTimezone(value: unknown): string {
  const candidate = typeof value === "string" && value.trim().length > 0 ? value.trim() : DEFAULT_POLICY_TIMEZONE;
  return DateTime.local().setZone(candidate).isValid ? candidate : DEFAULT_POLICY_TIMEZONE;
}

function resolveWeekdayKey(date: DateTime): WeekdayKey {
  const index = date.weekday - 1;
  return WEEKDAY_KEYS[index] ?? "monday";
}

function coerceTemplateGroup(value: unknown, fallback: TemplateGroup): TemplateGroup {
  const result: TemplateGroup = { ...fallback };
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item.trim().length > 0) {
      result[key] = item.trim();
    }
  }
  return result;
}

export function normalizePostalCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

export function isPostalCodeAllowed(postalCode: string, policy: ServiceAreaPolicy): boolean {
  const normalized = normalizePostalCode(postalCode);
  if (!normalized) return false;
  const list = Array.isArray(policy.zipAllowlist) ? policy.zipAllowlist : [];
  if (list.length === 0) return true;
  return list.includes(normalized);
}

export function resolveTemplateForChannel(
  templates: TemplateGroup,
  input: { inboundChannel?: string | null; replyChannel?: string | null }
): string | null {
  const inboundKey = input.inboundChannel?.toLowerCase();
  if (inboundKey && templates[inboundKey]) {
    return templates[inboundKey];
  }
  const replyKey = input.replyChannel?.toLowerCase();
  if (replyKey && templates[replyKey]) {
    return templates[replyKey];
  }
  if (templates["sms"]) return templates["sms"];
  if (templates["email"]) return templates["email"];
  return null;
}

export async function getPolicySetting(db: DbExecutor, key: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, key))
    .limit(1);
  return (row?.value as Record<string, unknown> | null) ?? null;
}

export async function getServiceAreaPolicy(db: DbExecutor = getDb()): Promise<ServiceAreaPolicy> {
  const stored = await getPolicySetting(db, "service_area");
  if (!stored) {
    return DEFAULT_SERVICE_AREA_POLICY;
  }

  const zipAllowlistRaw = stored["zipAllowlist"];
  const zipAllowlist = Array.isArray(zipAllowlistRaw)
    ? zipAllowlistRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : DEFAULT_SERVICE_AREA_POLICY.zipAllowlist;

  return {
    mode: "zip_allowlist",
    homeBase: typeof stored["homeBase"] === "string" ? stored["homeBase"] : DEFAULT_SERVICE_AREA_POLICY.homeBase,
    radiusMiles:
      typeof stored["radiusMiles"] === "number" && Number.isFinite(stored["radiusMiles"])
        ? stored["radiusMiles"]
        : DEFAULT_SERVICE_AREA_POLICY.radiusMiles,
    zipAllowlist,
    notes: typeof stored["notes"] === "string" ? stored["notes"] : DEFAULT_SERVICE_AREA_POLICY.notes
  };
}

export async function getBusinessHoursPolicy(db: DbExecutor = getDb()): Promise<BusinessHoursPolicy> {
  const stored = await getPolicySetting(db, "business_hours");
  if (!stored) {
    return DEFAULT_BUSINESS_HOURS_POLICY;
  }

  const timezone = resolveTimezone(stored["timezone"]);
  const weeklyRaw = isRecord(stored["weekly"]) ? (stored["weekly"] as Record<string, unknown>) : {};

  const weekly = WEEKDAY_KEYS.reduce<Record<WeekdayKey, TimeWindow[]>>((acc, key) => {
    acc[key] = coerceTimeWindowList(weeklyRaw[key], DEFAULT_BUSINESS_HOURS_POLICY.weekly[key]);
    return acc;
  }, {} as Record<WeekdayKey, TimeWindow[]>);

  return { timezone, weekly };
}

export async function getQuietHoursPolicy(db: DbExecutor = getDb()): Promise<QuietHoursPolicy> {
  const stored = await getPolicySetting(db, "quiet_hours");
  if (!stored) {
    return DEFAULT_QUIET_HOURS_POLICY;
  }

  const channelsRaw = isRecord(stored["channels"]) ? (stored["channels"] as Record<string, unknown>) : {};
  const channels: Record<string, TimeWindow> = { ...DEFAULT_QUIET_HOURS_POLICY.channels };

  for (const [channel, value] of Object.entries(channelsRaw)) {
    const window = coerceTimeWindow(value);
    if (window) {
      channels[channel] = window;
    }
  }

  return { channels };
}

export async function getTemplatesPolicy(db: DbExecutor = getDb()): Promise<TemplatesPolicy> {
  const stored = await getPolicySetting(db, "templates");
  if (!stored) {
    return DEFAULT_TEMPLATES_POLICY;
  }

  return {
    first_touch: coerceTemplateGroup(stored["first_touch"], DEFAULT_TEMPLATES_POLICY.first_touch),
    follow_up: coerceTemplateGroup(stored["follow_up"], DEFAULT_TEMPLATES_POLICY.follow_up),
    confirmations: coerceTemplateGroup(stored["confirmations"], DEFAULT_TEMPLATES_POLICY.confirmations),
    reviews: coerceTemplateGroup(stored["reviews"], DEFAULT_TEMPLATES_POLICY.reviews),
    out_of_area: coerceTemplateGroup(stored["out_of_area"], DEFAULT_TEMPLATES_POLICY.out_of_area)
  };
}

export async function getOutOfAreaMessage(
  channel: "sms" | "email" | "web",
  db: DbExecutor = getDb()
): Promise<string> {
  const templates = await getTemplatesPolicy(db);
  return (
    resolveTemplateForChannel(templates.out_of_area, { inboundChannel: channel, replyChannel: channel }) ??
    DEFAULT_TEMPLATES_POLICY.out_of_area["web"] ??
    DEFAULT_TEMPLATES_POLICY.out_of_area["sms"] ??
    "Thanks for reaching out! We currently serve areas within 50 miles of Woodstock."
  );
}

export async function getStandardJobPolicy(db: DbExecutor = getDb()): Promise<StandardJobPolicy> {
  const stored = await getPolicySetting(db, "standard_job");
  if (!stored) {
    return DEFAULT_STANDARD_JOB_POLICY;
  }

  const allowedServicesRaw = stored["allowedServices"];
  const allowedServices = Array.isArray(allowedServicesRaw)
    ? allowedServicesRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : DEFAULT_STANDARD_JOB_POLICY.allowedServices;

  const maxVolumeCubicYards =
    typeof stored["maxVolumeCubicYards"] === "number" && Number.isFinite(stored["maxVolumeCubicYards"])
      ? stored["maxVolumeCubicYards"]
      : DEFAULT_STANDARD_JOB_POLICY.maxVolumeCubicYards;

  const maxItemCount =
    typeof stored["maxItemCount"] === "number" && Number.isFinite(stored["maxItemCount"])
      ? stored["maxItemCount"]
      : DEFAULT_STANDARD_JOB_POLICY.maxItemCount;

  return {
    allowedServices,
    maxVolumeCubicYards,
    maxItemCount,
    notes: typeof stored["notes"] === "string" ? stored["notes"] : DEFAULT_STANDARD_JOB_POLICY.notes
  };
}

export async function getItemPoliciesPolicy(db: DbExecutor = getDb()): Promise<ItemPoliciesPolicy> {
  const stored = await getPolicySetting(db, "item_policies");
  if (!stored) {
    return DEFAULT_ITEM_POLICIES;
  }

  const declinedRaw = stored["declined"];
  const declined = Array.isArray(declinedRaw)
    ? declinedRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : DEFAULT_ITEM_POLICIES.declined;

  const extraFeesRaw = stored["extraFees"];
  const extraFees = Array.isArray(extraFeesRaw)
    ? extraFeesRaw
        .map((entry) => (isRecord(entry) ? entry : null))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => ({
          item: typeof entry["item"] === "string" ? entry["item"].trim() : "",
          fee: typeof entry["fee"] === "number" && Number.isFinite(entry["fee"]) ? entry["fee"] : NaN
        }))
        .filter((entry) => entry.item.length > 0 && Number.isFinite(entry.fee) && entry.fee >= 0)
    : DEFAULT_ITEM_POLICIES.extraFees;

  return { declined, extraFees };
}

export function getBusinessHourWindowsForDate(
  date: Date | DateTime,
  policy: BusinessHoursPolicy
): Array<{ start: DateTime; end: DateTime }> {
  const zone = resolveTimezone(policy.timezone);
  const local =
    date instanceof DateTime ? date.setZone(zone) : DateTime.fromJSDate(date, { zone: "utc" }).setZone(zone);
  const dayKey = resolveWeekdayKey(local);
  const windows = policy.weekly[dayKey] ?? [];
  const baseDay = local.startOf("day");

  return windows
    .map((window) => {
      const startTime = parseTimeString(window.start);
      const endTime = parseTimeString(window.end);
      if (!startTime || !endTime) return null;
      const start = baseDay.set({ hour: startTime.hour, minute: startTime.minute, second: 0, millisecond: 0 });
      const end = baseDay.set({ hour: endTime.hour, minute: endTime.minute, second: 0, millisecond: 0 });
      if (!start.isValid || !end.isValid || end <= start) return null;
      return { start, end };
    })
    .filter((entry): entry is { start: DateTime; end: DateTime } => Boolean(entry));
}

export function isWithinBusinessHours(
  startAt: Date,
  durationMinutes: number,
  policy: BusinessHoursPolicy
): boolean {
  const zone = resolveTimezone(policy.timezone);
  const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(zone);
  if (!startLocal.isValid) return false;
  const endLocal = startLocal.plus({ minutes: durationMinutes });
  const windows = getBusinessHourWindowsForDate(startLocal, policy);
  return windows.some((window) => startLocal >= window.start && endLocal <= window.end);
}

export function isQuietHoursActive(
  date: Date,
  channel: string,
  policy: QuietHoursPolicy,
  timezone: string
): boolean {
  const zone = resolveTimezone(timezone);
  const window = policy.channels[channel];
  if (!window) return false;
  const startTime = parseTimeString(window.start);
  const endTime = parseTimeString(window.end);
  if (!startTime || !endTime) return false;

  const local = DateTime.fromJSDate(date, { zone: "utc" }).setZone(zone);
  if (!local.isValid) return false;
  const minutes = local.hour * 60 + local.minute;
  const startMinutes = startTime.hour * 60 + startTime.minute;
  const endMinutes = endTime.hour * 60 + endTime.minute;

  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return minutes >= startMinutes && minutes < endMinutes;
  }
  return minutes >= startMinutes || minutes < endMinutes;
}

export function nextQuietHoursEnd(
  date: Date,
  channel: string,
  policy: QuietHoursPolicy,
  timezone: string
): Date | null {
  const zone = resolveTimezone(timezone);
  const window = policy.channels[channel];
  if (!window) return null;
  const startTime = parseTimeString(window.start);
  const endTime = parseTimeString(window.end);
  if (!startTime || !endTime) return null;

  const local = DateTime.fromJSDate(date, { zone: "utc" }).setZone(zone);
  if (!local.isValid) return null;
  const minutes = local.hour * 60 + local.minute;
  const startMinutes = startTime.hour * 60 + startTime.minute;
  const endMinutes = endTime.hour * 60 + endTime.minute;

  if (startMinutes === endMinutes) return null;

  if (startMinutes < endMinutes) {
    if (minutes < startMinutes || minutes >= endMinutes) return null;
    return local
      .set({ hour: endTime.hour, minute: endTime.minute, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
  }

  if (minutes >= startMinutes) {
    return local
      .plus({ days: 1 })
      .set({ hour: endTime.hour, minute: endTime.minute, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
  }

  if (minutes < endMinutes) {
    return local
      .set({ hour: endTime.hour, minute: endTime.minute, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
  }

  return null;
}

export async function getBookingRulesPolicy(db: DbExecutor = getDb()): Promise<BookingRulesPolicy> {
  const stored = await getPolicySetting(db, "booking_rules");
  if (!stored) {
    return DEFAULT_BOOKING_RULES_POLICY;
  }

  const bookingWindowDays =
    typeof stored["bookingWindowDays"] === "number" && Number.isFinite(stored["bookingWindowDays"])
      ? stored["bookingWindowDays"]
      : DEFAULT_BOOKING_RULES_POLICY.bookingWindowDays;
  const bufferMinutes =
    typeof stored["bufferMinutes"] === "number" && Number.isFinite(stored["bufferMinutes"])
      ? stored["bufferMinutes"]
      : DEFAULT_BOOKING_RULES_POLICY.bufferMinutes;
  const maxJobsPerDay =
    typeof stored["maxJobsPerDay"] === "number" && Number.isFinite(stored["maxJobsPerDay"])
      ? stored["maxJobsPerDay"]
      : DEFAULT_BOOKING_RULES_POLICY.maxJobsPerDay;
  const maxJobsPerCrew =
    typeof stored["maxJobsPerCrew"] === "number" && Number.isFinite(stored["maxJobsPerCrew"])
      ? stored["maxJobsPerCrew"]
      : DEFAULT_BOOKING_RULES_POLICY.maxJobsPerCrew;

  return {
    bookingWindowDays,
    bufferMinutes,
    maxJobsPerDay,
    maxJobsPerCrew
  };
}

export async function getConfirmationLoopPolicy(db: DbExecutor = getDb()): Promise<ConfirmationLoopPolicy> {
  const stored = await getPolicySetting(db, "confirmation_loop");
  if (!stored) {
    return DEFAULT_CONFIRMATION_LOOP_POLICY;
  }

  const enabled = stored["enabled"] === true;
  const windowsRaw = stored["windowsMinutes"];
  const windowsMinutes = Array.isArray(windowsRaw)
    ? windowsRaw.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    : DEFAULT_CONFIRMATION_LOOP_POLICY.windowsMinutes;

  return {
    enabled,
    windowsMinutes: windowsMinutes.length ? windowsMinutes : DEFAULT_CONFIRMATION_LOOP_POLICY.windowsMinutes
  };
}

export async function getFollowUpSequencePolicy(db: DbExecutor = getDb()): Promise<FollowUpSequencePolicy> {
  const stored = await getPolicySetting(db, "follow_up_sequence");
  if (!stored) {
    return DEFAULT_FOLLOW_UP_SEQUENCE_POLICY;
  }

  const enabled = stored["enabled"] !== false;
  const stepsRaw = stored["stepsMinutes"];
  const stepsMinutes = Array.isArray(stepsRaw)
    ? stepsRaw.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    : DEFAULT_FOLLOW_UP_SEQUENCE_POLICY.stepsMinutes;

  return {
    enabled,
    stepsMinutes: stepsMinutes.length ? stepsMinutes : DEFAULT_FOLLOW_UP_SEQUENCE_POLICY.stepsMinutes
  };
}

function coerceInt(value: unknown, fallback: number, { min, max }: { min: number; max: number }): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  return Math.min(max, Math.max(min, rounded));
}

function coerceString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

export async function getCompanyProfilePolicy(db: DbExecutor = getDb()): Promise<CompanyProfilePolicy> {
  const stored = await getPolicySetting(db, "company_profile");
  if (!stored) {
    return DEFAULT_COMPANY_PROFILE_POLICY;
  }

  return {
    businessName: coerceString(stored["businessName"], DEFAULT_COMPANY_PROFILE_POLICY.businessName),
    primaryPhone: coerceString(stored["primaryPhone"], DEFAULT_COMPANY_PROFILE_POLICY.primaryPhone),
    serviceAreaSummary: coerceString(
      stored["serviceAreaSummary"],
      DEFAULT_COMPANY_PROFILE_POLICY.serviceAreaSummary
    ),
    trailerAndPricingSummary: coerceString(
      stored["trailerAndPricingSummary"],
      DEFAULT_COMPANY_PROFILE_POLICY.trailerAndPricingSummary
    ),
    whatWeDo: coerceString(stored["whatWeDo"], DEFAULT_COMPANY_PROFILE_POLICY.whatWeDo),
    whatWeDontDo: coerceString(stored["whatWeDontDo"], DEFAULT_COMPANY_PROFILE_POLICY.whatWeDontDo),
    bookingStyle: coerceString(stored["bookingStyle"], DEFAULT_COMPANY_PROFILE_POLICY.bookingStyle),
    agentNotes: coerceString(stored["agentNotes"], DEFAULT_COMPANY_PROFILE_POLICY.agentNotes)
  };
}

export async function getSalesAutopilotPolicy(db: DbExecutor = getDb()): Promise<SalesAutopilotPolicy> {
  const stored = await getPolicySetting(db, "sales_autopilot");
  if (!stored) {
    return DEFAULT_SALES_AUTOPILOT_POLICY;
  }

  return {
    enabled: stored["enabled"] !== false,
    autoSendAfterMinutes: coerceInt(stored["autoSendAfterMinutes"], DEFAULT_SALES_AUTOPILOT_POLICY.autoSendAfterMinutes, {
      min: 1,
      max: 120
    }),
    activityWindowMinutes: coerceInt(
      stored["activityWindowMinutes"],
      DEFAULT_SALES_AUTOPILOT_POLICY.activityWindowMinutes,
      { min: 1, max: 120 }
    ),
    retryDelayMinutes: coerceInt(stored["retryDelayMinutes"], DEFAULT_SALES_AUTOPILOT_POLICY.retryDelayMinutes, {
      min: 1,
      max: 60
    }),
    agentDisplayName: coerceString(stored["agentDisplayName"], DEFAULT_SALES_AUTOPILOT_POLICY.agentDisplayName)
  };
}
