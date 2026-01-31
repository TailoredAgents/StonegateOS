import type {
  AddOnConfig,
  AvailabilityWindow,
  BundleConfig,
  PricingContext,
  ServiceBaseRate,
  WeeklyAvailability,
  ZoneConfig
} from "../types";

export const zones: ZoneConfig[] = [
  {
    id: "zone-core",
    name: "Core Service Area",
    tier: "core",
    travelFee: 0,
    zipCodes: []
  },
  {
    id: "zone-extended",
    name: "Extended Service Area",
    tier: "extended",
    travelFee: 25,
    zipCodes: []
  },
  {
    id: "zone-premium",
    name: "Premium Service Area",
    tier: "premium",
    travelFee: 50,
    zipCodes: []
  }
];

export const serviceRates: ServiceBaseRate[] = [
  {
    service: "house-wash",
    label: "Whole Home Soft-Wash",
    description: "Low-pressure wash for siding, brick, and soffits.",
    basePrice: 189,
    pricePerSquareFoot: 0.18,
    minimumSquareFootage: 1200
  },
  // Junk removal catalog (additive; keep legacy wash services for compatibility)
  {
    service: "junk-removal",
    label: "Junk Removal (Trailer Pricing)",
    description: "Trailer-based pricing tiers (quarter/half/3/4/full).",
    basePrice: 0
  },
  {
    service: "single-item",
    label: "Rubbish",
    description: "Common household waste hauled away.",
    flatRate: 95,
    basePrice: 95
  },
  {
    service: "furniture",
    label: "Furniture Removal",
    description: "Sofas, dressers, desks, and more.",
    basePrice: 180
  },
  {
    service: "appliances",
    label: "Appliance Removal",
    description: "Refrigerators, washers, dryers; freon fees may apply.",
    basePrice: 150
  },
  {
    service: "yard-waste",
    label: "Yard Waste & Debris",
    description: "Brush, branches, and bagged leaves.",
    basePrice: 140
  },
  {
    service: "construction-debris",
    label: "Construction Debris",
    description: "Renovation leftovers and materials.",
    basePrice: 220
  },
  {
    service: "hot-tub",
    label: "Hot Tub Removal",
    description: "Cut-up and haul away.",
    basePrice: 450
  },
  // Custom line item (priced manually by team)
  {
    service: "other",
    label: "Other",
    description: "Custom service or item not listed",
    basePrice: 0
  },
  {
    service: "driveway",
    label: "Driveway Degrease",
    description: "Surface clean concrete or paver driveways.",
    basePrice: 149,
    pricePerSquareFoot: 0.14,
    minimumSquareFootage: 600
  },
  {
    service: "roof",
    label: "Roof Treatment",
    description: "Soft-wash for shingles to remove algae streaking.",
    basePrice: 299,
    pricePerSquareFoot: 0.35,
    minimumSquareFootage: 800
  },
  {
    service: "deck",
    label: "Deck & Patio Restore",
    description: "Restore decks, patios, or screened porches.",
    basePrice: 129,
    pricePerSquareFoot: 0.2,
    minimumSquareFootage: 400
  },
  {
    service: "gutter",
    label: "Gutter Clear & Flush",
    description: "Hand-clear gutters and flush downspouts.",
    flatRate: 179,
    basePrice: 179
  },
  {
    service: "commercial",
    label: "Commercial Exterior",
    description: "Custom pricing for storefronts and multi-unit properties.",
    basePrice: 499,
    pricePerSquareFoot: 0.25,
    includesTravel: true
  }
];

export const bundles: BundleConfig[] = [
  {
    id: "bundle-exterior-refresh",
    name: "Exterior Refresh",
    services: ["house-wash", "driveway"],
    discountPercentage: 10
  },
  {
    id: "bundle-total-protect",
    name: "Total Protect",
    services: ["house-wash", "roof", "gutter"],
    discountPercentage: 15
  }
];

export const addOns: AddOnConfig[] = [
  {
    id: "addon-window-rinse",
    name: "Exterior Window Rinse",
    description: "Spot-free rinse for first-floor windows.",
    service: "house-wash",
    price: 75
  },
  {
    id: "addon-wood-seal",
    name: "Deck Wood Sealant",
    description: "Protective sealant applied after cleaning.",
    service: "deck",
    price: 120
  }
];

const defaultZone: ZoneConfig = zones[0] ?? {
  id: "zone-core-fallback",
  name: "Core Service Area",
  tier: "core",
  travelFee: 0,
  zipCodes: []
};

export const defaultPricingContext: PricingContext = {
  zone: defaultZone,
  services: serviceRates,
  bundles,
  addOns
};

export const defaultDepositRate = 0.2;

export const availabilityWindows: AvailabilityWindow[] = [
  { id: "morning", label: "Morning (8:00-12:00)", startHour: 8, endHour: 12 },
  { id: "afternoon", label: "Afternoon (12:00-16:00)", startHour: 12, endHour: 16 },
  { id: "evening", label: "Evening (16:00-18:00)", startHour: 16, endHour: 18 }
] as const;

export const weeklyAvailability: WeeklyAvailability = {
  serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  startHour: 8,
  endHour: 18,
  quietHours: {
    startHour: 21,
    endHour: 8
  }
};
