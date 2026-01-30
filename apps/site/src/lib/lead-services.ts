export type LeadServiceOption = {
  slug: string;
  title: string;
  description?: string;
};

export const DEFAULT_LEAD_SERVICE_OPTIONS: LeadServiceOption[] = [
  { slug: "single-item", title: "Rubbish", description: "Common household waste" },
  { slug: "furniture", title: "Furniture Removal", description: "Sofas, dressers, desks, and more" },
  { slug: "appliances", title: "Appliance Removal", description: "Refrigerators, washers, dryers" },
  { slug: "yard-waste", title: "Yard Waste & Debris", description: "Brush, branches, and bagged leaves" },
  { slug: "brush-clearing", title: "Brush Clearing", description: "Overgrowth, vines, and storm debris" },
  { slug: "construction-debris", title: "Construction Debris", description: "Renovation leftovers and materials" },
  { slug: "hot-tub", title: "Hot Tub Removal", description: "Cut-up and haul away" }
];
