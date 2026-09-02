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
      schedule: "Schedule site service",
      jobs: "Review jobsite work",
      locations: "Manage worksites",
      proof: "Review jobsite proof",
      repeat_work: "Repeat jobsite work",
    },
    overview: {
      eyebrow: "Contractor operations",
      description:
        "Coordinate jobsite service, crew access, material details, and closeout proof without losing the field context.",
      nextActionHeading: "Keep the next jobsite moving",
      nextActionLead:
        "Start with the site and scope, then give the field team the details needed for a clean handoff.",
      nextActions: [
        {
          id: "locations",
          label: "Prepare a worksite",
          description:
            "Save parking, loading, superintendent, and access details for reuse.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Schedule site service",
          description:
            "Describe the material, equipment needs, hazards, and deadline before choosing a window.",
          href: "/partners/book",
        },
        {
          id: "proof",
          label: "Review jobsite proof",
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
      scopeHeading: "Plan the field scope",
      scopeLead:
        "Give the crew enough jobsite context to plan labor, equipment, access, and the service window.",
      descriptionLabel: "What work should be completed?",
      descriptionPlaceholder:
        "Describe materials, work areas, approximate volume, heavy items, demolition status, site readiness, deadlines, and anything the crew should plan for.",
      scopeChecklist: [
        "Material type, item count, or estimated volume",
        "Exact pickup or work area and site-readiness status",
        "Loading, parking, elevator, or equipment constraints",
        "Hazards, heavy items, restricted material, and deadlines",
      ],
      proofHeading: "Suggested contractor proof",
      proofLead:
        "Apply a starting point only if it fits this job. Every proof field remains editable before submission.",
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
      schedule: "Schedule property service",
      jobs: "Review property work",
      locations: "Manage properties",
      proof: "Review property proof",
      repeat_work: "Repeat property work",
    },
    overview: {
      eyebrow: "Real-estate operations",
      description:
        "Coordinate listing, closing, and turnover service with property access, deadlines, and client-ready proof in one record.",
      nextActionHeading: "Prepare the next property milestone",
      nextActionLead:
        "Start with the property and deadline, then capture the access and proof details needed for a smooth handoff.",
      nextActions: [
        {
          id: "locations",
          label: "Add a property",
          description:
            "Save the property, listing reference, access method, and on-site contact.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Schedule property service",
          description:
            "Tie the scope to a listing, closing, inspection, or turnover deadline.",
          href: "/partners/book",
        },
        {
          id: "proof",
          label: "Share listing-ready proof",
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
      scopeHeading: "Prepare the property scope",
      scopeLead:
        "Connect the work to the property milestone so Stonegate can plan access, timing, and a clear client handoff.",
      descriptionLabel: "What should be ready at the property?",
      descriptionPlaceholder:
        "Describe rooms or exterior areas, items to remove, occupied status, listing or closing deadline, client expectations, and anything that must remain.",
      scopeChecklist: [
        "Listing, closing, inspection, or turnover deadline",
        "Rooms, areas, items to remove, and items that must remain",
        "Occupied status, lockbox or key process, and access hours",
        "Agent, seller, buyer, tenant, or estate contact for the visit",
      ],
      proofHeading: "Suggested property proof",
      proofLead:
        "Choose a starting point only when it matches the client handoff. You can change every proof field.",
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
      schedule: "Schedule property work",
      jobs: "Review active turns",
      locations: "Manage the portfolio",
      proof: "Review turnover proof",
      repeat_work: "Repeat portfolio work",
    },
    overview: {
      eyebrow: "Property operations",
      description:
        "Coordinate unit turns, common-area work, site contacts, recurring service, and proof across a managed portfolio.",
      nextActionHeading: "Keep the portfolio service-ready",
      nextActionLead:
        "Start with reusable property details, then standardize turnover scope and evidence across locations.",
      nextActions: [
        {
          id: "locations",
          label: "Organize the portfolio",
          description:
            "Save property, unit, office, parking, elevator, and access details.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Schedule property work",
          description:
            "Capture the unit or area, turnover deadline, contact, and required proof.",
          href: "/partners/book",
        },
        {
          id: "jobs",
          label: "Review active turns",
          description:
            "Track requests, approvals, schedule changes, messages, and completion status.",
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
      scopeHeading: "Define the property task",
      scopeLead:
        "Name the unit or common area, turnover milestone, access path, and documentation needed for the property record.",
      descriptionLabel: "What does this property need?",
      descriptionPlaceholder:
        "Describe the unit or common area, move-out condition, items or material, turnover deadline, tenant status, and make-ready dependencies.",
      scopeChecklist: [
        "Property, building, unit, or common-area identifier",
        "Move-out, move-in, inspection, or make-ready deadline",
        "Tenant status, key process, office contact, and access hours",
        "Parking, elevator, loading, and documentation requirements",
      ],
      proofHeading: "Suggested turnover proof",
      proofLead:
        "Apply a portfolio starting point only when it fits this property. The job-level requirements remain editable.",
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
      schedule: "Schedule facility service",
      jobs: "Track commercial work",
      locations: "Manage facilities",
      proof: "Review closeout proof",
      repeat_work: "Repeat commercial work",
    },
    overview: {
      eyebrow: "Commercial operations",
      description:
        "Coordinate facility service, operational constraints, commercial references, approvals, proof, and repeat work in one workspace.",
      nextActionHeading: "Prepare the next facility request",
      nextActionLead:
        "Start with the operating site and commercial references, then capture safety, access, and closeout needs.",
      nextActions: [
        {
          id: "locations",
          label: "Prepare a facility",
          description:
            "Save dock, access, business-hour, safety, and site-contact details.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Schedule facility service",
          description:
            "Capture scope, resource needs, PO or cost center, and service constraints.",
          href: "/partners/book",
        },
        {
          id: "jobs",
          label: "Track commercial work",
          description:
            "Review approvals, active service, change requests, proof, and records.",
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
      scopeHeading: "Define the facility scope",
      scopeLead:
        "Capture the operational and commercial context Stonegate needs to plan resources and route approvals safely.",
      descriptionLabel: "What should be completed at the facility?",
      descriptionPlaceholder:
        "Describe materials, quantity or volume, work areas, business-hour constraints, resource needs, safety requirements, project milestone, and deadline.",
      scopeChecklist: [
        "Facility, department, floor, suite, or project identifier",
        "Material, estimated quantity or volume, and resource needs",
        "Dock, loading, security, escort, and operating-hour constraints",
        "PO, cost center, approver, safety rules, and closeout standard",
      ],
      proofHeading: "Suggested commercial proof",
      proofLead:
        "Apply a closeout starting point only when it matches the work order. Every requirement remains editable.",
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
      schedule: "Schedule a job",
      jobs: "Review jobs",
      locations: "Manage locations",
      proof: "Photos & proof",
      repeat_work: "Repeat service work",
    },
    overview: {
      eyebrow: "Partner services",
      description:
        "Coordinate locations, service requests, access details, job updates, and completion proof in one account workspace.",
      nextActionHeading: "Prepare the next service request",
      nextActionLead:
        "Start with a reusable location, then capture the work, access, contact, and documentation needed for a clear handoff.",
      nextActions: [
        {
          id: "locations",
          label: "Prepare a location",
          description:
            "Save site contacts, access, parking, loading, and service details.",
          href: "/partners/properties",
        },
        {
          id: "schedule",
          label: "Schedule a job",
          description:
            "Describe the scope, add photos, and choose an available or preferred window.",
          href: "/partners/book",
        },
        {
          id: "jobs",
          label: "Review jobs",
          description:
            "Track status, messages, changes, proof, and account records.",
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
      scopeHeading: "Describe the service scope",
      scopeLead:
        "Give Stonegate enough location, work, access, and timing context to plan the right service safely.",
      descriptionLabel: "What needs to be done?",
      descriptionPlaceholder:
        "Describe the items, material, rooms or work area, access, heavy pieces, deadlines, and anything else the crew should plan for.",
      scopeChecklist: [
        "Items, material, work areas, and estimated quantity",
        "On-site contact and access process",
        "Parking, loading, elevator, or equipment constraints",
        "Hazards, special handling, deadlines, and required proof",
      ],
      proofHeading: "Suggested service proof",
      proofLead:
        "Apply a starting point only if it fits this job. Every proof field remains editable.",
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
