export type SeoTopic = {
  key: string;
  titleHint: string;
  primaryKeyword: string;
  relatedServiceSlugs: Array<
    "furniture" | "appliances" | "yard-waste" | "construction-debris" | "hot-tub" | "single-item"
  >;
};

export const SEO_TOPICS: SeoTopic[] = [
  {
    key: "prepare-for-junk-removal",
    titleHint: "How to Prepare for a Junk Removal Pickup (North Metro Atlanta)",
    primaryKeyword: "how to prepare for junk removal",
    relatedServiceSlugs: ["single-item", "furniture", "appliances"]
  },
  {
    key: "garage-cleanout-checklist",
    titleHint: "Garage Cleanout Checklist: Clear Space Fast Without the Stress",
    primaryKeyword: "garage cleanout checklist",
    relatedServiceSlugs: ["furniture", "appliances", "construction-debris"]
  },
  {
    key: "basement-cleanout-tips",
    titleHint: "Basement Cleanout Tips: What to Keep, Donate, and Haul Away",
    primaryKeyword: "basement cleanout tips",
    relatedServiceSlugs: ["furniture", "appliances", "single-item"]
  },
  {
    key: "yard-waste-pickup-guide",
    titleHint: "Yard Waste Pickup Guide: What We Can Haul and How to Bundle It",
    primaryKeyword: "yard waste pickup",
    relatedServiceSlugs: ["yard-waste", "single-item"]
  },
  {
    key: "appliance-removal-guide",
    titleHint: "Appliance Removal 101: The Easy Way to Get Rid of Old Appliances",
    primaryKeyword: "appliance removal",
    relatedServiceSlugs: ["appliances", "single-item"]
  },
  {
    key: "construction-debris-removal",
    titleHint: "Construction Debris Removal After a Remodel: A Simple Game Plan",
    primaryKeyword: "construction debris removal",
    relatedServiceSlugs: ["construction-debris"]
  },
  {
    key: "estate-cleanout-guide",
    titleHint: "Estate Cleanout Guide: A Practical Checklist for Families",
    primaryKeyword: "estate cleanout",
    relatedServiceSlugs: ["furniture", "appliances", "single-item"]
  },
  {
    key: "moving-cleanout-tips",
    titleHint: "Moving Soon? Cleanout Tips to Reduce Stress and Save Space",
    primaryKeyword: "moving cleanout",
    relatedServiceSlugs: ["furniture", "appliances", "yard-waste"]
  },
  {
    key: "donate-or-haul",
    titleHint: "Donate vs. Haul: How to Decide What to Give Away and What to Remove",
    primaryKeyword: "donate or haul away",
    relatedServiceSlugs: ["furniture", "appliances", "single-item"]
  },
  {
    key: "hot-tub-removal-what-to-know",
    titleHint: "Hot Tub Removal: What to Know Before You Schedule",
    primaryKeyword: "hot tub removal",
    relatedServiceSlugs: ["hot-tub"]
  },
  {
    key: "mattress-disposal-atlanta",
    titleHint: "Mattress Disposal in North Metro Atlanta: The Simple, Responsible Option",
    primaryKeyword: "mattress disposal",
    relatedServiceSlugs: ["furniture", "single-item"]
  },
  {
    key: "paint-disposal-tips",
    titleHint: "Paint Disposal Tips: What to Do With Old Cans During a Cleanout",
    primaryKeyword: "paint disposal",
    relatedServiceSlugs: ["construction-debris", "single-item"]
  },
  {
    key: "rubbish-removal",
    titleHint: "Rubbish Removal: Common Household Waste Pickup Made Easy",
    primaryKeyword: "rubbish removal",
    relatedServiceSlugs: ["single-item"]
  },
  {
    key: "spring-cleaning-junk-removal",
    titleHint: "Spring Cleaning in North Metro Atlanta: A Cleanout Plan That Works",
    primaryKeyword: "spring cleaning junk removal",
    relatedServiceSlugs: ["furniture", "appliances", "yard-waste"]
  },
  {
    key: "office-junk-removal",
    titleHint: "Office Junk Removal: How to Clear Out Furniture and Equipment Fast",
    primaryKeyword: "office junk removal",
    relatedServiceSlugs: ["furniture", "appliances", "construction-debris"]
  },
  {
    key: "storage-unit-cleanout",
    titleHint: "Storage Unit Cleanout: Make Room and Stop Paying for Unused Stuff",
    primaryKeyword: "storage unit cleanout",
    relatedServiceSlugs: ["furniture", "appliances", "single-item"]
  },
  {
    key: "junk-removal-marietta-ga",
    titleHint: "Junk Removal in Marietta, GA: What to Expect and How to Get Scheduled",
    primaryKeyword: "junk removal marietta ga",
    relatedServiceSlugs: ["furniture", "appliances", "yard-waste"]
  },
  {
    key: "junk-removal-roswell-ga",
    titleHint: "Junk Removal in Roswell, GA: A Simple Guide for Homeowners",
    primaryKeyword: "junk removal roswell ga",
    relatedServiceSlugs: ["furniture", "appliances", "single-item"]
  },
  {
    key: "junk-removal-woodstock-ga",
    titleHint: "Junk Removal in Woodstock, GA: Quick Answers and Pickup Prep Tips",
    primaryKeyword: "junk removal woodstock ga",
    relatedServiceSlugs: ["furniture", "appliances", "yard-waste"]
  }
];
