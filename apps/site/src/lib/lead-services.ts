export type LeadServiceOption = {
  slug: string;
  title: string;
  description?: string;
};

export const DEFAULT_LEAD_SERVICE_OPTIONS: LeadServiceOption[] = [
  { slug: "single-item", title: "Single Item Pickup", description: "Mattress, TV, or small furniture" },
  { slug: "furniture", title: "Furniture Removal", description: "Sofas, dressers, desks, and more" },
  { slug: "appliances", title: "Appliance Removal", description: "Refrigerators, washers, dryers" },
  { slug: "yard-waste", title: "Yard Waste & Debris", description: "Brush, branches, and bagged leaves" },
  { slug: "construction-debris", title: "Construction Debris", description: "Renovation leftovers and materials" },
  { slug: "hot-tub", title: "Hot Tub Removal", description: "Cut-up and haul away" }
];
