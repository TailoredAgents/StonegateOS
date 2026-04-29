export const JUNK_SINGLE_ITEM_PRICE = 175;
export const JUNK_QUARTER_LOAD_PRICE = 220;

export const JUNK_VOLUME_UNIT_PRICE = JUNK_QUARTER_LOAD_PRICE;

export const JUNK_VOLUME_PRICING = {
  singleItem: JUNK_SINGLE_ITEM_PRICE,
  quarter: JUNK_QUARTER_LOAD_PRICE,
  half: 350,
  threeQuarter: 500,
  full: 750
} as const;
