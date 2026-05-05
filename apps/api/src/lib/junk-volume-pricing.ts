export const JUNK_SINGLE_ITEM_PRICE = 175;
export const JUNK_QUARTER_LOAD_PRICE = 195;

export const JUNK_VOLUME_UNIT_PRICE = JUNK_QUARTER_LOAD_PRICE;

export const JUNK_VOLUME_PRICING = {
  singleItem: JUNK_SINGLE_ITEM_PRICE,
  quarter: JUNK_QUARTER_LOAD_PRICE,
  half: 320,
  threeQuarter: 480,
  full: 630,
} as const;
