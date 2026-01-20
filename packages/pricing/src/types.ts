export type ServiceCategory =
  | "house-wash"
  | "driveway"
  | "roof"
  | "deck"
  | "gutter"
  | "commercial"
  // Junk removal catalog (non-breaking additions)
  | "junk-removal"
  | "single-item"
  | "furniture"
  | "appliances"
  | "yard-waste"
  | "construction-debris"
  | "hot-tub"
  // Generic catch-all for custom items
  | "other";

export type ZoneTier = "core" | "extended" | "premium";

export interface ZoneConfig {
  id: string;
  name: string;
  tier: ZoneTier;
  travelFee: number;
  zipCodes: string[];
}

export interface ServiceBaseRate {
  service: ServiceCategory;
  label: string;
  description?: string;
  basePrice: number;
  minimumSquareFootage?: number;
  pricePerSquareFoot?: number;
  flatRate?: number;
  includesTravel?: boolean;
}

export interface BundleConfig {
  id: string;
  name: string;
  services: ServiceCategory[];
  discountPercentage: number;
}

export interface AddOnConfig {
  id: string;
  name: string;
  service: ServiceCategory;
  price: number;
  description?: string;
}

export interface PricingContext {
  zone: ZoneConfig;
  services: ServiceBaseRate[];
  bundles: BundleConfig[];
  addOns: AddOnConfig[];
}

export interface AvailabilityWindow {
  id: string;
  label: string;
  startHour: number;
  endHour: number;
}

export type ServiceDay =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface WeeklyAvailability {
  serviceDays: readonly ServiceDay[];
  startHour: number;
  endHour: number;
  quietHours: {
    startHour: number;
    endHour: number;
  };
}

export type ConcreteSurfaceKind = "driveway" | "deck" | "other";

export interface ConcreteSurfaceInput {
  kind: ConcreteSurfaceKind;
  squareFeet: number;
}

export type LineItemCategory =
  | "service"
  | "add-on"
  | "travel"
  | "discount"
  | "deposit"
  | "fee"
  | "other";

export interface QuoteRequestInput {
  zoneId: string;
  surfaceArea?: number;
  selectedServices: ServiceCategory[];
  selectedAddOns?: string[];
  applyBundles?: boolean;
  depositRate?: number;
  serviceOverrides?: Partial<Record<ServiceCategory, number>>;
  concreteSurfaces?: ConcreteSurfaceInput[];
}

export interface LineItem {
  id: string;
  label: string;
  amount: number;
  category?: LineItemCategory;
}

export interface QuoteBreakdown {
  subtotal: number;
  travelFee: number;
  discounts: number;
  addOnsTotal: number;
  total: number;
  depositDue: number;
  balanceDue: number;
  depositRate: number;
  lineItems: LineItem[];
}

