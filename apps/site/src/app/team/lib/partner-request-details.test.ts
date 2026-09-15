import assert from "node:assert/strict";
import test from "node:test";
import { visiblePartnerAppointmentNotes } from "./partner-request-notes";
import {
  parsePartnerRequestDetails,
  parsePartnerRequestPhotos,
  type PartnerRequestDetails,
} from "@myst-os/sdk";

const request: PartnerRequestDetails = {
  version: 1,
  jobId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  accountName: "Sample Bakery",
  service: {
    key: "service_request",
    label: "Service request",
    tierKey: null,
    tierLabel: null,
  },
  publicStatus: "requested",
  confirmationMode: "review",
  originalJob: null,
  visibility: { financials: false, photos: true },
  location: null,
  description: "Full supplied description. ".repeat(320),
  onSiteContact: {
    name: "Morgan Lee",
    phone: null,
    email: "morgan@example.test",
  },
  alternateContact: {
    name: "Evening supervisor",
    phone: "+14045550101",
    email: null,
  },
  accessDetails: "Use the loading dock.",
  crewInstructions: "Keep the cold-room door closed.",
  scope: {
    itemCount: 0,
    volumeCubicYards: 0,
    restrictedItems: false,
    nonStandard: false,
    hazardCategories: [],
    equipmentNeeds: ["heavy_lift"],
    requiredCompletion: null,
    multiStop: false,
    multiStopDetails: null,
    additionalFields: [],
  },
  addOns: [],
  commercial: {
    poNumber: "PO-2042",
    costCenter: "BAKERY",
    projectReference: null,
    billingContact: null,
  },
  proof: { before: 0, after: null, package: false },
  scheduling: {
    timezone: "America/New_York",
    preferredWindows: [
      {
        localDate: "2026-10-01",
        timeOfDay: "afternoon",
        timezone: "America/New_York",
      },
    ],
    requestedWindow: null,
    confirmedWindow: null,
    confirmedStartAt: null,
    assistancePreference: "callback",
  },
  photos: {
    count: 0,
    detailPath:
      "/api/admin/partner-management/v1/service-requests/11111111-1111-4111-8111-111111111111",
  },
};

void test("staff request parsing preserves complete supplied text, zero requirements and legacy unknown values", () => {
  const parsed = parsePartnerRequestDetails({
    ...request,
    accessSecret: "must-not-be-presented",
  });
  assert.ok(parsed);
  assert.equal(parsed.description, request.description);
  assert.equal(parsed.proof.before, 0);
  assert.equal(parsed.proof.after, null);
  assert.equal(parsed.scope.itemCount, 0);
  assert.deepEqual(parsed.alternateContact, request.alternateContact);
  assert.deepEqual(
    parsed.scheduling.preferredWindows,
    request.scheduling.preferredWindows,
  );
  assert.equal("accessSecret" in parsed, false);
});

void test("incomplete details and malformed photo refreshes remain errors instead of empty results", () => {
  assert.equal(parsePartnerRequestDetails({ ...request, scope: null }), null);
  assert.equal(
    parsePartnerRequestDetails({
      ...request,
      scheduling: { preferredWindows: [] },
    }),
    null,
  );
  assert.equal(parsePartnerRequestPhotos(undefined), null);
  assert.equal(
    parsePartnerRequestPhotos([
      {
        id: "photo",
        category: "intake",
        caption: "Boxes",
        status: "ready",
        url: { wrong: true },
      },
    ]),
    null,
  );
  assert.deepEqual(parsePartnerRequestPhotos([]), []);
  const photos = [
    {
      id: "photo",
      category: "issue",
      caption: "Inspect the loading dock before arrival.",
      filename: "loading-dock.jpg",
      status: "ready",
      url: "https://media.example.test/photo",
    },
  ];
  assert.deepEqual(parsePartnerRequestPhotos(photos), photos);
});

void test("structured partner requests replace only same-account generated notes and preserve staff writing", () => {
  const noteRequest = {
    ...request,
    description: "Remove the old shelves.",
    crewInstructions: "Keep the cold-room door closed.",
  };
  const generated = {
    id: "generated",
    body: [
      "[partner-portal-v2-review-request]",
      `Partner account: ${noteRequest.accountId}`,
      "Requested by: morgan@example.test",
      `Service: ${noteRequest.service.key}`,
      "Preferred dates: 2026-10-01 (afternoon)",
      "Scheduling assistance: callback",
      `Description: ${noteRequest.description}`,
      `Crew instructions: ${noteRequest.crewInstructions}`,
      "Review reasons: manual_review_required, required_completion_deadline",
    ].join("\n"),
  };
  const human = {
    id: "human",
    body: "Keep this staff note and its reference: " + "A".repeat(100),
  };
  const mentioned = {
    id: "mentioned",
    body: "Please check [partner-portal-v2-review-request] before dispatch.",
  };
  const appended = {
    id: "appended",
    body: generated.body + "\nStaff update: bring an extra crew member.",
  };
  const otherAccount = {
    id: "other",
    body: generated.body.replace(noteRequest.accountId, "another-account"),
  };
  const inserted = {
    id: "inserted",
    body: generated.body.replace(
      "Review reasons:",
      "Staff update: bring an extra crew member.\nReview reasons:",
    ),
  };
  const changedDescription = {
    id: "changed-description",
    body: generated.body.replace(
      noteRequest.description,
      "Staff corrected the work description.",
    ),
  };
  const changedService = {
    id: "changed-service",
    body: generated.body.replace(
      `Service: ${noteRequest.service.key}`,
      "Service: changed_service",
    ),
  };
  const changedDates = {
    id: "changed-dates",
    body: generated.body.replace(
      "2026-10-01 (afternoon)",
      "2026-10-02 (morning)",
    ),
  };
  const notes = [
    generated,
    human,
    mentioned,
    appended,
    otherAccount,
    inserted,
    changedDescription,
    changedService,
    changedDates,
  ];
  assert.deepEqual(visiblePartnerAppointmentNotes(notes, noteRequest), [
    human,
    mentioned,
    appended,
    otherAccount,
    inserted,
    changedDescription,
    changedService,
    changedDates,
  ]);
  assert.deepEqual(visiblePartnerAppointmentNotes(notes, null), notes);
  assert.deepEqual(
    visiblePartnerAppointmentNotes(notes, { ...noteRequest, scope: null }),
    notes,
  );
  assert.deepEqual(visiblePartnerAppointmentNotes(undefined, noteRequest), []);
  const multilineRequest = {
    ...noteRequest,
    description: "Shelf one.\nShelf two.",
    crewInstructions: "Keep the door closed.\nUse the loading bay.",
  };
  const multilineNote = {
    ...generated,
    body: generated.body.replace(
      `Description: ${noteRequest.description}\nCrew instructions: ${noteRequest.crewInstructions}`,
      `Description: ${multilineRequest.description}\nCrew instructions: ${multilineRequest.crewInstructions}`,
    ),
  };
  assert.deepEqual(
    visiblePartnerAppointmentNotes([multilineNote], multilineRequest),
    [],
  );
  const changedCrew = {
    ...multilineNote,
    body: multilineNote.body.replace(
      "Use the loading bay.",
      "Use the front door.",
    ),
  };
  assert.deepEqual(
    visiblePartnerAppointmentNotes([changedCrew], multilineRequest),
    [changedCrew],
  );
});

void test("held booking notes match exact optional add-ons and review reasons while preserving edits", () => {
  const bookingRequest: PartnerRequestDetails = {
    ...request,
    description: "Remove the shelves.\nLeave the pallet.",
    crewInstructions: "Use the loading bay.\nKeep the cold-room door closed.",
    addOns: [
      {
        key: "stairs",
        label: "Stair carry",
        unitLabel: "floor",
        quantity: 2,
        unitAmountMinor: null,
        lineTotalMinor: null,
        currency: null,
        requiresReview: true,
      },
      {
        key: "extra_crew",
        label: "Additional crew member",
        unitLabel: "person",
        quantity: 1,
        unitAmountMinor: null,
        lineTotalMinor: null,
        currency: null,
        requiresReview: false,
      },
    ],
  };
  const generated = {
    id: "held-generated",
    body: [
      "[partner-portal-v2-booking]",
      `Partner account: ${bookingRequest.accountId}`,
      "Requested by: morgan@example.test",
      `Service: ${bookingRequest.service.key}`,
      "Add-ons: Stair carry × 2, Additional crew member × 1",
      `Description: ${bookingRequest.description}`,
      `Crew instructions: ${bookingRequest.crewInstructions}`,
    ].join("\n"),
  };
  const reviewed = {
    id: "held-reviewed",
    body:
      generated.body +
      "\nReview reasons: manual_review_required, additional_crew",
  };
  assert.deepEqual(
    visiblePartnerAppointmentNotes([generated, reviewed], bookingRequest),
    [],
  );
  const changed = [
    {
      id: "held-extra",
      body: reviewed.body.replace(
        "Review reasons:",
        "Staff update: bring the lift.\nReview reasons:",
      ),
    },
    {
      id: "held-addons",
      body: generated.body.replace("Stair carry × 2", "Stair carry × 3"),
    },
    {
      id: "held-description",
      body: generated.body.replace("Leave the pallet.", "Take the pallet too."),
    },
    {
      id: "held-crew",
      body: generated.body.replace(
        "Use the loading bay.",
        "Use the front entrance.",
      ),
    },
    {
      id: "held-account",
      body: generated.body.replace(bookingRequest.accountId, "another-account"),
    },
    {
      id: "held-appended",
      body: generated.body + "\nStaff update: call before arrival.",
    },
  ];
  assert.deepEqual(
    visiblePartnerAppointmentNotes(changed, bookingRequest),
    changed,
  );
  const minimalRequest = {
    ...bookingRequest,
    addOns: [],
    description: null,
    crewInstructions: null,
  };
  const minimalNote = {
    id: "held-minimal",
    body: generated.body.split("\n").slice(0, 4).join("\n"),
  };
  assert.deepEqual(
    visiblePartnerAppointmentNotes([minimalNote], minimalRequest),
    [],
  );
  assert.deepEqual(visiblePartnerAppointmentNotes([generated], null), [
    generated,
  ]);
});
