/**
 * Presentation-only guidance for the Partner Portal launch audiences.
 *
 * Persona can change labels and suggestions, but it is never an authorization
 * input. Keep capabilities, roles, scopes, account state, and mutations out of
 * this module. Callers must apply their existing authorization checks before
 * rendering any linked task.
 */
export const PARTNER_LAUNCH_PERSONAS = [
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
] as const;

export type PartnerLaunchPersona = (typeof PARTNER_LAUNCH_PERSONAS)[number];
export type PartnerPresentationPersona = PartnerLaunchPersona | "fallback";

export type PartnerPersonaTaskId =
  | "schedule"
  | "jobs"
  | "locations"
  | "proof"
  | "repeat_work";

export type PartnerPersonaTaskPresentation = {
  id: PartnerPersonaTaskId;
  label: string;
  description: string;
  href:
    | "/partners/book"
    | "/partners/bookings"
    | "/partners/properties"
    | "/partners/photos";
};

export type PartnerPersonaProofPreset = {
  id: string;
  label: string;
  description: string;
  before: number;
  after: number;
  package: boolean;
};

export type PartnerPersonaTemplateSuggestion = {
  name: string;
  description: string;
  checklist: readonly string[];
};

export type PartnerPersonaPresentation = {
  key: PartnerPresentationPersona;
  label: string;
  taskLabels: Readonly<Record<PartnerPersonaTaskId, string>>;
  overview: {
    eyebrow: string;
    description: string;
    nextActionHeading: string;
    nextActionLead: string;
    nextActions: readonly PartnerPersonaTaskPresentation[];
  };
  onboarding: {
    checklistLead: string;
    confirmationTitle: string;
    confirmationBody: string;
    nextActions: readonly string[];
  };
  booking: {
    scopeHeading: string;
    scopeLead: string;
    descriptionLabel: string;
    descriptionPlaceholder: string;
    scopeChecklist: readonly string[];
    proofHeading: string;
    proofLead: string;
    proofPresets: readonly PartnerPersonaProofPreset[];
  };
  repeatWork: {
    title: string;
    lead: string;
    starterTemplates: readonly PartnerPersonaTemplateSuggestion[];
  };
};

export const PARTNER_PERSONA_COPY_LIMITS = {
  shortLabel: 48,
  heading: 88,
  description: 240,
  prompt: 180,
  placeholder: 280,
  checklistItem: 160,
} as const;

const PRESENTATIONS = {
  contractor: {
    key: "contractor",
    label: "Contractor",
    taskLabels: {
      schedule: "Request jobsite service",
      jobs: "Jobsite jobs",
      locations: "Saved worksites",
      proof: "Jobsite proof",
      repeat_work: "Reuse jobsite details",
    },
    overview: {
      eyebrow: "Quick service for contractors",
      description:
        "Request jobsite service with saved site details, then follow updates and closeout proof without repeating the field context.",
      nextActionHeading: "Get the next site handled",
      nextActionLead:
        "Reuse the worksite, add only what changed, and send one complete request.",
      nextActions: [
        {
          id: "locations",
          label: "Save a worksite once",
          description:
            "Save parking, loading, superintendent, and access details for reuse.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Request jobsite service",
          description:
            "Use the saved site, add the current scope and photos, and choose a window.",
          href: "/partners/book",
        },
        {
          id: "proof",
          label: "Get closeout proof",
          description:
            "Keep before, after, issue, and completion evidence with the job.",
          href: "/partners/photos",
        },
      ],
    },
    onboarding: {
      checklistLead:
        "Set up a reusable worksite, field communication, and closeout proof before the first request.",
      confirmationTitle: "Your contractor workflow is noted",
      confirmationBody:
        "Stonegate will review the company and access path. If approved, the workspace will help your team coordinate sites, scope, and completion proof.",
      nextActions: [
        "Gather the worksite address and on-site contact.",
        "Decide which before-and-after evidence clients require.",
        "Prepare common access, loading, and safety instructions.",
      ],
    },
    booking: {
      scopeHeading: "Tell us what this job needs",
      scopeLead:
        "Start with the saved worksite, then add only the material, access, and timing that are different.",
      descriptionLabel: "What work should be completed?",
      descriptionPlaceholder:
        "Describe materials, work areas, approximate volume, heavy items, demolition status, site readiness, deadlines, and anything the crew should plan for.",
      scopeChecklist: [
        "Material type, item count, or estimated volume",
        "Exact pickup or work area and site-readiness status",
        "Loading, parking, elevator, or equipment constraints",
        "Hazards, heavy items, restricted material, and deadlines",
      ],
      proofHeading: "Choose the proof you need",
      proofLead:
        "Use a preset to save time, then adjust it for this job if needed.",
      proofPresets: [
        {
          id: "contractor_handoff",
          label: "Field handoff",
          description: "One starting-condition and one completion image.",
          before: 1,
          after: 1,
          package: false,
        },
        {
          id: "contractor_closeout",
          label: "Client closeout",
          description:
            "Two before and two after images with a shareable package.",
          before: 2,
          after: 2,
          package: true,
        },
      ],
    },
    repeatWork: {
      title: "Repeat jobsite work",
      lead: "Save a reviewed job as a template when the same scope and site instructions recur.",
      starterTemplates: [
        {
          name: "Jobsite debris pickup",
          description:
            "A repeatable pickup with material, volume, loading, and superintendent details.",
          checklist: ["Material and volume", "Loading access", "Site contact"],
        },
        {
          name: "Renovation cleanout",
          description:
            "A phase-based cleanout with readiness, restricted-material, and closeout-proof notes.",
          checklist: ["Project phase", "Hazard review", "Proof requirement"],
        },
      ],
    },
  },
  real_estate_agent: {
    key: "real_estate_agent",
    label: "Real-estate professional",
    taskLabels: {
      schedule: "Request property service",
      jobs: "Property jobs",
      locations: "Saved properties",
      proof: "Property proof",
      repeat_work: "Reuse property details",
    },
    overview: {
      eyebrow: "Quick service for real-estate teams",
      description:
        "Request listing, closing, or turnover service quickly with saved property details and client-ready proof in one place.",
      nextActionHeading: "Get the property ready",
      nextActionLead:
        "Choose a saved property, add the deadline and what changed, then send the request.",
      nextActions: [
        {
          id: "locations",
          label: "Save a property once",
          description:
            "Save the property, listing reference, access method, and on-site contact.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Request property service",
          description:
            "Add the current scope and tie it to the listing, closing, or turnover date.",
          href: "/partners/book",
        },
        {
          id: "proof",
          label: "Get client-ready proof",
          description:
            "Review completion photos before updating a seller, buyer, or client.",
          href: "/partners/photos",
        },
      ],
    },
    onboarding: {
      checklistLead:
        "Prepare one property, communication preferences, and client-facing proof defaults for the first request.",
      confirmationTitle: "Your real-estate workflow is noted",
      confirmationBody:
        "Stonegate will review the company and access path. If approved, the workspace will organize property deadlines, access, and completion evidence.",
      nextActions: [
        "Gather the property address, listing reference, and deadline.",
        "Confirm lockbox, key, tenant, or agent access instructions.",
        "Decide what completion proof the client should receive.",
      ],
    },
    booking: {
      scopeHeading: "Tell us what the property needs",
      scopeLead:
        "Start with the saved property, then add the deadline, access changes, and work needed now.",
      descriptionLabel: "What should be ready at the property?",
      descriptionPlaceholder:
        "Describe rooms or exterior areas, items to remove, occupied status, listing or closing deadline, client expectations, and anything that must remain.",
      scopeChecklist: [
        "Listing, closing, inspection, or turnover deadline",
        "Rooms, areas, items to remove, and items that must remain",
        "Occupied status, lockbox or key process, and access hours",
        "Agent, seller, buyer, tenant, or estate contact for the visit",
      ],
      proofHeading: "Choose the proof you need",
      proofLead:
        "Use a preset for a faster client handoff, then adjust it if needed.",
      proofPresets: [
        {
          id: "listing_ready",
          label: "Listing-ready handoff",
          description:
            "One before and two after images with a shareable package.",
          before: 1,
          after: 2,
          package: true,
        },
        {
          id: "agent_check",
          label: "Agent verification",
          description: "One before and one after image for a quick review.",
          before: 1,
          after: 1,
          package: false,
        },
      ],
    },
    repeatWork: {
      title: "Repeat property work",
      lead: "Use a completed property job as the safe base for recurring listing or turnover requests.",
      starterTemplates: [
        {
          name: "Pre-listing removal",
          description:
            "A property-prep request with deadline, access, keep/remove, and proof details.",
          checklist: ["Listing deadline", "Keep/remove notes", "Access method"],
        },
        {
          name: "Closing-day cleanout",
          description:
            "A time-sensitive cleanout with stakeholder contact and shareable completion evidence.",
          checklist: ["Closing date", "Property contact", "Proof package"],
        },
      ],
    },
  },
  property_manager: {
    key: "property_manager",
    label: "Property manager",
    taskLabels: {
      schedule: "Request property service",
      jobs: "Property jobs",
      locations: "Saved properties",
      proof: "Turnover proof",
      repeat_work: "Reuse property details",
    },
    overview: {
      eyebrow: "Quick service for property teams",
      description:
        "Request unit-turn or common-area service with saved property details, then follow every job and proof record in one place.",
      nextActionHeading: "Keep properties moving",
      nextActionLead:
        "Reuse property and access details, add the unit or area, and send the request.",
      nextActions: [
        {
          id: "locations",
          label: "Save property details",
          description:
            "Save property, unit, office, parking, elevator, and access details.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Request property service",
          description:
            "Choose the property, add the unit or area, and select a service window.",
          href: "/partners/book",
        },
        {
          id: "jobs",
          label: "See active jobs",
          description:
            "See status, approvals, schedule changes, messages, and completion proof.",
          href: "/partners/bookings",
        },
      ],
    },
    onboarding: {
      checklistLead:
        "Add the first managed property, standard proof, communication preferences, and the right teammates.",
      confirmationTitle: "Your property-management workflow is noted",
      confirmationBody:
        "Stonegate will review the company and access path. If approved, the workspace will support locations, unit turns, recurring work, and proof.",
      nextActions: [
        "Identify the first property, unit naming pattern, and site contact.",
        "Document office, key, parking, elevator, and tenant access rules.",
        "Choose a standard turnover proof expectation for future jobs.",
      ],
    },
    booking: {
      scopeHeading: "Tell us what this property needs",
      scopeLead:
        "Start with saved property details, then add the unit, deadline, and work needed now.",
      descriptionLabel: "What does this property need?",
      descriptionPlaceholder:
        "Describe the unit or common area, move-out condition, items or material, turnover deadline, tenant status, and make-ready dependencies.",
      scopeChecklist: [
        "Property, building, unit, or common-area identifier",
        "Move-out, move-in, inspection, or make-ready deadline",
        "Tenant status, key process, office contact, and access hours",
        "Parking, elevator, loading, and documentation requirements",
      ],
      proofHeading: "Choose the turnover proof",
      proofLead:
        "Use a preset to save time, then adjust it for this property if needed.",
      proofPresets: [
        {
          id: "unit_turnover",
          label: "Unit turnover record",
          description:
            "Two before and two after images with a shareable package.",
          before: 2,
          after: 2,
          package: true,
        },
        {
          id: "common_area",
          label: "Common-area check",
          description: "One before and one after image for the property file.",
          before: 1,
          after: 1,
          package: false,
        },
      ],
    },
    repeatWork: {
      title: "Repeat portfolio work",
      lead: "Standardize recurring unit-turn and common-area details without carrying over secrets, pricing, or old proof.",
      starterTemplates: [
        {
          name: "Unit turnover",
          description:
            "A reusable move-out request with unit, key, deadline, and proof expectations.",
          checklist: ["Unit identifier", "Key process", "Turn deadline"],
        },
        {
          name: "Common-area pickup",
          description:
            "A repeat property request with loading access, site contact, and service cadence.",
          checklist: ["Service area", "Loading access", "Property contact"],
        },
      ],
    },
  },
  commercial_client: {
    key: "commercial_client",
    label: "Commercial client",
    taskLabels: {
      schedule: "Request facility service",
      jobs: "Facility jobs",
      locations: "Saved facilities",
      proof: "Closeout proof",
      repeat_work: "Reuse facility details",
    },
    overview: {
      eyebrow: "Quick service for commercial teams",
      description:
        "Request facility service with saved site and billing details, then follow approvals, updates, and closeout records in one place.",
      nextActionHeading: "Get the next facility job started",
      nextActionLead:
        "Reuse the facility details and add only the scope, references, and safety needs for this job.",
      nextActions: [
        {
          id: "locations",
          label: "Save a facility once",
          description:
            "Save dock, access, business-hour, safety, and site-contact details.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Request facility service",
          description:
            "Use the saved site, add scope and references, and choose a service window.",
          href: "/partners/book",
        },
        {
          id: "jobs",
          label: "See facility jobs",
          description:
            "See approvals, status, change requests, proof, and records.",
          href: "/partners/bookings",
        },
      ],
    },
    onboarding: {
      checklistLead:
        "Prepare a facility, proof defaults, billing details, communication preferences, and the right account team.",
      confirmationTitle: "Your commercial workflow is noted",
      confirmationBody:
        "Stonegate will review the company and access path. If approved, the workspace will organize facilities, approvals, references, proof, and reporting.",
      nextActions: [
        "Gather the first facility address, hours, dock, and site contact.",
        "Confirm PO, cost-center, billing, and approval expectations.",
        "Document safety, access, and closeout requirements.",
      ],
    },
    booking: {
      scopeHeading: "Tell us what the facility needs",
      scopeLead:
        "Start with the saved facility, then add the work, references, and operating details that are different.",
      descriptionLabel: "What should be completed at the facility?",
      descriptionPlaceholder:
        "Describe materials, quantity or volume, work areas, business-hour constraints, resource needs, safety requirements, project milestone, and deadline.",
      scopeChecklist: [
        "Facility, department, floor, suite, or project identifier",
        "Material, estimated quantity or volume, and resource needs",
        "Dock, loading, security, escort, and operating-hour constraints",
        "PO, cost center, approver, safety rules, and closeout standard",
      ],
      proofHeading: "Choose the closeout proof",
      proofLead:
        "Use a preset to save time, then adjust it to match this work order.",
      proofPresets: [
        {
          id: "facility_closeout",
          label: "Facility closeout",
          description:
            "Two before and two after images with a shareable package.",
          before: 2,
          after: 2,
          package: true,
        },
        {
          id: "work_order_check",
          label: "Work-order check",
          description: "One before and one after image for internal records.",
          before: 1,
          after: 1,
          package: false,
        },
      ],
    },
    repeatWork: {
      title: "Repeat commercial work",
      lead: "Use reviewed jobs to standardize recurring facility scope while keeping each schedule and approval explicit.",
      starterTemplates: [
        {
          name: "Office cleanout",
          description:
            "A project request with suite, loading, business-hour, reference, and proof details.",
          checklist: ["Suite or project", "Loading plan", "PO or cost center"],
        },
        {
          name: "Recurring facility pickup",
          description:
            "A repeat request with site constraints, material expectations, and an on-site contact.",
          checklist: ["Material profile", "Service cadence", "Site contact"],
        },
      ],
    },
  },
  fallback: {
    key: "fallback",
    label: "Partner",
    taskLabels: {
      schedule: "Request service",
      jobs: "Jobs",
      locations: "Saved locations",
      proof: "Photos & proof",
      repeat_work: "Reuse service details",
    },
    overview: {
      eyebrow: "Quick and easy partner service",
      description:
        "Request service with saved locations and details, then follow job updates and completion proof in one place.",
      nextActionHeading: "Get service started",
      nextActionLead:
        "Choose a saved location, add what is different, and send one complete request.",
      nextActions: [
        {
          id: "locations",
          label: "Save a location once",
          description:
            "Save site contacts, access, parking, loading, and service details.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Request service",
          description:
            "Add the current details and photos, then choose an available or preferred window.",
          href: "/partners/book",
        },
        {
          id: "jobs",
          label: "See your jobs",
          description:
            "See status, the next step, messages, changes, proof, and records.",
          href: "/partners/bookings",
        },
      ],
    },
    onboarding: {
      checklistLead:
        "Prepare the first location, communication preferences, proof defaults, billing details, and account team.",
      confirmationTitle: "Your service needs are noted",
      confirmationBody:
        "Stonegate will review the company and access path. If approved, the workspace will organize service requests, updates, and completion records.",
      nextActions: [
        "Gather the first service address and on-site contact.",
        "Document access, parking, loading, and timing constraints.",
        "Decide what before-and-after evidence the job requires.",
      ],
    },
    booking: {
      scopeHeading: "Tell us what you need",
      scopeLead:
        "Start with the saved location, then add the work, access, and timing details that are different.",
      descriptionLabel: "What needs to be done?",
      descriptionPlaceholder:
        "Describe the items, material, rooms or work area, access, heavy pieces, deadlines, and anything else the crew should plan for.",
      scopeChecklist: [
        "Items, material, work areas, and estimated quantity",
        "On-site contact and access process",
        "Parking, loading, elevator, or equipment constraints",
        "Hazards, special handling, deadlines, and required proof",
      ],
      proofHeading: "Choose the proof you need",
      proofLead:
        "Use a preset to save time, then adjust it for this job if needed.",
      proofPresets: [
        {
          id: "standard_handoff",
          label: "Standard handoff",
          description: "One starting-condition and one completion image.",
          before: 1,
          after: 1,
          package: false,
        },
        {
          id: "documented_closeout",
          label: "Documented closeout",
          description:
            "Two before and two after images with a shareable package.",
          before: 2,
          after: 2,
          package: true,
        },
      ],
    },
    repeatWork: {
      title: "Repeat service work",
      lead: "Use a reviewed job as a reusable starting point without carrying over secrets, media, pricing, or old approvals.",
      starterTemplates: [
        {
          name: "Standard service request",
          description:
            "A repeatable request with scope, site access, contact, and proof expectations.",
          checklist: ["Scope", "Access", "Contact"],
        },
        {
          name: "Recurring pickup",
          description:
            "A repeat request with material, preferred cadence, and location details.",
          checklist: ["Material", "Cadence", "Location"],
        },
      ],
    },
  },
} as const satisfies Record<
  PartnerPresentationPersona,
  PartnerPersonaPresentation
>;

export const PARTNER_PERSONA_PRESENTATIONS: Readonly<
  Record<PartnerPresentationPersona, PartnerPersonaPresentation>
> = PRESENTATIONS;

const PERSONA_ALIASES: Readonly<Record<string, PartnerLaunchPersona>> = {
  contractor: "contractor",
  trade_contractor: "contractor",
  real_estate: "real_estate_agent",
  real_estate_agent: "real_estate_agent",
  realtor: "real_estate_agent",
  property_management: "property_manager",
  property_manager: "property_manager",
  commercial: "commercial_client",
  commercial_client: "commercial_client",
};

export function resolvePartnerPresentationPersona(
  value: string | null | undefined,
): PartnerPresentationPersona {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "") ?? "";
  return PERSONA_ALIASES[normalized] ?? "fallback";
}

export function getPartnerPersonaPresentation(
  value: string | null | undefined,
): PartnerPersonaPresentation {
  return PARTNER_PERSONA_PRESENTATIONS[
    resolvePartnerPresentationPersona(value)
  ];
}
