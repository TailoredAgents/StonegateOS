import {
  buildExpenseReceiptReview,
  detectExpenseReceiptDuplicates,
  ExactDuplicateOverrideSchema,
  ExpenseAllocationSetSchema,
  ExpenseReceiptExtractionSchema,
  normalizeReceiptVendor,
  selectExpenseCategory,
  validateExpenseAllocations,
  validateExpenseReceiptExtraction,
  type ExpenseReceiptExtraction,
  type VendorCategoryRule,
} from "@/lib/expense-receipt-domain";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function validExtraction(
  overrides: Partial<ExpenseReceiptExtraction> = {},
): ExpenseReceiptExtraction {
  return {
    vendor: "Stonegate Fuel",
    transactionDate: "2026-08-24",
    totalCents: 7_543,
    taxCents: 543,
    paymentLastFour: "4242",
    suggestedCategoryId: "fuel",
    lineItems: [
      { description: "Diesel", amountCents: 7_000 },
      { description: "Tax", amountCents: 543 },
    ],
    warnings: [],
    fieldConfidence: {
      vendor: 0.99,
      transactionDate: 0.98,
      totalCents: 0.99,
      taxCents: 0.92,
      paymentLastFour: 0.9,
      suggestedCategoryId: 0.88,
      lineItems: 0.84,
    },
    ...overrides,
  };
}

describe("expense receipt extraction contract", () => {
  it("accepts bounded strict output and preserves evidence exactly", () => {
    const extraction = validExtraction({
      vendor: "  Stonegate Fuel  ",
      warnings: ["  Total includes a handwritten tip.  "],
    });
    const result = validateExpenseReceiptExtraction(extraction);

    expect(result).toEqual({
      ok: true,
      extraction: {
        ...extraction,
        vendor: "Stonegate Fuel",
        warnings: ["Total includes a handwritten tip."],
      },
    });
  });

  it("represents every missing value as null without inventing defaults", () => {
    const result = ExpenseReceiptExtractionSchema.parse({
      vendor: null,
      transactionDate: null,
      totalCents: null,
      taxCents: null,
      paymentLastFour: null,
      suggestedCategoryId: null,
      lineItems: null,
      warnings: ["Receipt is partially obscured."],
      fieldConfidence: {
        vendor: null,
        transactionDate: null,
        totalCents: null,
        taxCents: null,
        paymentLastFour: null,
        suggestedCategoryId: null,
        lineItems: null,
      },
    });

    expect(result.vendor).toBeNull();
    expect(result.transactionDate).toBeNull();
    expect(result.totalCents).toBeNull();
    expect(result.suggestedCategoryId).toBeNull();
  });

  it("rejects omitted, extra, or internally inconsistent model fields", () => {
    const valid = validExtraction();
    const { totalCents: _omitted, ...withoutTotal } = valid;

    expect(ExpenseReceiptExtractionSchema.safeParse(withoutTotal).success).toBe(
      false,
    );
    expect(
      ExpenseReceiptExtractionSchema.safeParse({
        ...valid,
        modelCommentary: "probably right",
      }).success,
    ).toBe(false);
    expect(
      ExpenseReceiptExtractionSchema.safeParse({
        ...valid,
        totalCents: null,
        fieldConfidence: {
          ...valid.fieldConfidence,
          totalCents: 0.4,
        },
      }).success,
    ).toBe(false);
    expect(
      ExpenseReceiptExtractionSchema.safeParse({
        ...valid,
        vendor: "Fuel Stop",
        fieldConfidence: {
          ...valid.fieldConfidence,
          vendor: null,
        },
      }).success,
    ).toBe(false);
    expect(
      ExpenseReceiptExtractionSchema.safeParse({
        ...valid,
        fieldConfidence: {
          ...valid.fieldConfidence,
          hiddenConfidence: 1,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["impossible date", { transactionDate: "2026-02-30" }],
    ["ambiguous date", { transactionDate: "08/24/2026" }],
    ["zero total", { totalCents: 0 }],
    ["fractional total", { totalCents: 2_345.67 }],
    ["invalid card digits", { paymentLastFour: "42X2" }],
    ["noncanonical category", { suggestedCategoryId: "Fuel costs" }],
    ["empty line items", { lineItems: [] }],
  ])("rejects %s", (_label, override) => {
    expect(
      ExpenseReceiptExtractionSchema.safeParse({
        ...validExtraction(),
        ...override,
      }).success,
    ).toBe(false);
  });

  it("rejects tax greater than total and confidence outside 0 through 1", () => {
    expect(
      ExpenseReceiptExtractionSchema.safeParse(
        validExtraction({ totalCents: 100, taxCents: 101 }),
      ).success,
    ).toBe(false);
    expect(
      ExpenseReceiptExtractionSchema.safeParse({
        ...validExtraction(),
        fieldConfidence: {
          ...validExtraction().fieldConfidence,
          totalCents: 1.01,
        },
      }).success,
    ).toBe(false);
  });

  it("returns stable field paths for invalid worker output", () => {
    const result = validateExpenseReceiptExtraction({
      ...validExtraction(),
      transactionDate: "not-a-date",
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ field: "transactionDate" }],
    });
  });
});

describe("expense receipt human-review semantics", () => {
  it("blanks missing or low-confidence dates and totals and labels Check this", () => {
    const extraction = validExtraction({
      transactionDate: "2026-08-24",
      totalCents: null,
      fieldConfidence: {
        ...validExtraction().fieldConfidence,
        transactionDate: 0.79,
        totalCents: null,
      },
    });
    const review = buildExpenseReceiptReview(extraction);

    expect(review.fields.transactionDate).toEqual({
      value: null,
      confidence: 0.79,
      status: "check_this",
      attentionLabel: "Check this",
      reason: "low_confidence",
    });
    expect(review.fields.totalCents).toEqual({
      value: null,
      confidence: null,
      status: "check_this",
      attentionLabel: "Check this",
      reason: "missing",
    });
    expect(review.fieldsToCheck).toEqual(["transactionDate", "totalCents"]);
    expect(review.requiresHumanConfirmation).toBe(true);
  });

  it("accepts the confidence boundary but still requires confirmation", () => {
    const extraction = validExtraction({
      fieldConfidence: {
        ...validExtraction().fieldConfidence,
        transactionDate: 0.8,
        totalCents: 0.8,
      },
    });
    const review = buildExpenseReceiptReview(extraction);

    expect(review.fields.transactionDate).toMatchObject({
      value: "2026-08-24",
      status: "ready",
      attentionLabel: null,
    });
    expect(review.fields.totalCents).toMatchObject({
      value: 7_543,
      status: "ready",
      attentionLabel: null,
    });
    expect(review.requiresHumanConfirmation).toBe(true);
  });

  it("does not make absent optional details look erroneous", () => {
    const extraction = validExtraction({
      taxCents: null,
      paymentLastFour: null,
      lineItems: null,
      fieldConfidence: {
        ...validExtraction().fieldConfidence,
        taxCents: null,
        paymentLastFour: null,
        lineItems: null,
      },
    });
    const review = buildExpenseReceiptReview(extraction);

    expect(review.fields.taxCents).toMatchObject({
      value: null,
      status: "ready",
      reason: null,
    });
    expect(review.fields.paymentLastFour.status).toBe("ready");
    expect(review.fields.lineItems.status).toBe("ready");
  });

  it("rejects an invalid confidence policy instead of silently weakening it", () => {
    expect(() => buildExpenseReceiptReview(validExtraction(), -0.01)).toThrow(
      RangeError,
    );
    expect(() => buildExpenseReceiptReview(validExtraction(), 1.01)).toThrow(
      RangeError,
    );
    expect(() =>
      buildExpenseReceiptReview(validExtraction(), Number.NaN),
    ).toThrow(RangeError);
  });
});

describe("receipt duplicate detection", () => {
  it("prioritizes case-insensitive exact SHA-256 matches independent of OCR", () => {
    const result = detectExpenseReceiptDuplicates(
      {
        sha256: SHA_A,
        vendor: "One Vendor",
        totalCents: 5_000,
        transactionDate: "2026-08-24",
      },
      [
        {
          id: "expense-exact",
          sha256: SHA_A.toUpperCase(),
          vendor: "Different Vendor",
          totalCents: 999,
          transactionDate: "2020-01-01",
        },
        {
          id: "expense-fuzzy",
          sha256: SHA_B,
          vendor: "One Vendor",
          totalCents: 5_000,
          transactionDate: "2026-08-23",
        },
      ],
    );

    expect(result).toEqual({
      highestRisk: "exact",
      exactMatches: [{ candidateId: "expense-exact", kind: "exact" }],
      fuzzyMatches: [
        {
          candidateId: "expense-fuzzy",
          kind: "fuzzy",
          normalizedVendor: "one vendor",
          daysApart: 1,
        },
      ],
    });
  });

  it("matches fuzzy duplicates only on normalized vendor, exact cents, and nearby date", () => {
    const result = detectExpenseReceiptDuplicates(
      {
        sha256: SHA_A,
        vendor: "  CAFÉ & BAR, LLC  ",
        totalCents: 12_345,
        transactionDate: "2026-03-09",
      },
      [
        {
          id: "same-day",
          sha256: SHA_B,
          vendor: "Cafe and Bar LLC",
          totalCents: 12_345,
          transactionDate: "2026-03-09",
        },
        {
          id: "three-days",
          sha256: SHA_C,
          vendor: "CAFE & BAR LLC",
          totalCents: 12_345,
          transactionDate: "2026-03-12",
        },
        {
          id: "four-days",
          sha256: null,
          vendor: "Cafe and Bar LLC",
          totalCents: 12_345,
          transactionDate: "2026-03-13",
        },
        {
          id: "wrong-cents",
          sha256: null,
          vendor: "Cafe and Bar LLC",
          totalCents: 12_346,
          transactionDate: "2026-03-09",
        },
        {
          id: "wrong-vendor",
          sha256: null,
          vendor: "Cafe and Grill LLC",
          totalCents: 12_345,
          transactionDate: "2026-03-09",
        },
      ],
    );

    expect(normalizeReceiptVendor("  CAFÉ & BAR, LLC  ")).toBe(
      "cafe and bar llc",
    );
    expect(result.highestRisk).toBe("fuzzy");
    expect(result.fuzzyMatches.map((match) => match.candidateId)).toEqual([
      "same-day",
      "three-days",
    ]);
    expect(result.fuzzyMatches.map((match) => match.daysApart)).toEqual([0, 3]);
  });

  it("does not fuzzy-match when any required comparison evidence is missing", () => {
    for (const receipt of [
      {
        sha256: SHA_A,
        vendor: null,
        totalCents: 5_000,
        transactionDate: "2026-08-24",
      },
      {
        sha256: SHA_A,
        vendor: "Vendor",
        totalCents: null,
        transactionDate: "2026-08-24",
      },
      {
        sha256: SHA_A,
        vendor: "Vendor",
        totalCents: 5_000,
        transactionDate: null,
      },
    ]) {
      expect(
        detectExpenseReceiptDuplicates(receipt, [
          {
            id: "candidate",
            sha256: SHA_B,
            vendor: "Vendor",
            totalCents: 5_000,
            transactionDate: "2026-08-24",
          },
        ]).fuzzyMatches,
      ).toEqual([]);
    }
  });

  it("rejects malformed hashes, dates, and unsafe duplicate windows", () => {
    expect(() =>
      detectExpenseReceiptDuplicates(
        {
          sha256: "not-a-hash",
          vendor: null,
          totalCents: null,
          transactionDate: null,
        },
        [],
      ),
    ).toThrow();
    expect(() =>
      detectExpenseReceiptDuplicates(
        {
          sha256: SHA_A,
          vendor: "Vendor",
          totalCents: 100,
          transactionDate: "2026-02-30",
        },
        [],
      ),
    ).toThrow();
    expect(() =>
      detectExpenseReceiptDuplicates(
        {
          sha256: SHA_A,
          vendor: null,
          totalCents: null,
          transactionDate: null,
        },
        [],
        { maxNearbyDays: 32 },
      ),
    ).toThrow();
  });

  it("requires a bounded recorded reason for an exact-duplicate override", () => {
    expect(
      ExactDuplicateOverrideSchema.parse({ reason: "  Receipt reissued  " }),
    ).toEqual({ reason: "Receipt reissued" });
    expect(
      ExactDuplicateOverrideSchema.safeParse({ reason: "x" }).success,
    ).toBe(false);
    expect(
      ExactDuplicateOverrideSchema.safeParse({
        reason: "Receipt reissued",
        ownerOverride: true,
      }).success,
    ).toBe(false);
  });
});

function rule(overrides: Partial<VendorCategoryRule>): VendorCategoryRule {
  return {
    ruleId: "rule-default",
    vendor: "Acme Supply",
    categoryId: "supplies",
    ownerLocked: false,
    categoryConfirmationCount: 0,
    vendorConfirmationCount: 0,
    ...overrides,
  };
}

describe("vendor category learning precedence", () => {
  it("applies an owner-locked rule ahead of learned evidence and AI", () => {
    const selection = selectExpenseCategory({
      vendor: "  ÁCME SUPPLY, INC. ",
      rules: [
        rule({
          ruleId: "learned",
          vendor: "Acme Supply Inc",
          categoryId: "equipment",
          categoryConfirmationCount: 20,
          vendorConfirmationCount: 20,
        }),
        rule({
          ruleId: "owner",
          vendor: "ACME SUPPLY INC.",
          categoryId: "office_admin",
          ownerLocked: true,
        }),
      ],
      aiSuggestedCategoryId: "other",
    });

    expect(selection).toEqual({
      categoryId: "office_admin",
      source: "owner_locked",
      ruleId: "owner",
      confirmationCount: 0,
      agreement: 0,
    });
  });

  it("uses learned rules only at three confirmations and 80 percent agreement", () => {
    expect(
      selectExpenseCategory({
        vendor: "Vendor",
        rules: [
          rule({
            ruleId: "too-few",
            vendor: "Vendor",
            categoryId: "fuel",
            categoryConfirmationCount: 2,
            vendorConfirmationCount: 2,
          }),
          rule({
            ruleId: "too-divided",
            vendor: "Vendor",
            categoryId: "equipment",
            categoryConfirmationCount: 3,
            vendorConfirmationCount: 4,
          }),
          rule({
            ruleId: "boundary",
            vendor: "Vendor",
            categoryId: "supplies",
            categoryConfirmationCount: 4,
            vendorConfirmationCount: 5,
          }),
        ],
        aiSuggestedCategoryId: "other",
      }),
    ).toEqual({
      categoryId: "supplies",
      source: "learned",
      ruleId: "boundary",
      confirmationCount: 4,
      agreement: 0.8,
    });
  });

  it("chooses the strongest eligible learned rule deterministically", () => {
    const selection = selectExpenseCategory({
      vendor: "Vendor",
      rules: [
        rule({
          ruleId: "many-at-eighty",
          vendor: "Vendor",
          categoryId: "fuel",
          categoryConfirmationCount: 80,
          vendorConfirmationCount: 100,
        }),
        rule({
          ruleId: "unanimous",
          vendor: "Vendor",
          categoryId: "vehicle",
          categoryConfirmationCount: 3,
          vendorConfirmationCount: 3,
        }),
      ],
      aiSuggestedCategoryId: "other",
    });

    expect(selection.source).toBe("learned");
    expect(selection.ruleId).toBe("unanimous");
    expect(selection.agreement).toBe(1);
  });

  it("falls back to AI when no qualifying vendor rule exists", () => {
    expect(
      selectExpenseCategory({
        vendor: "Different Vendor",
        rules: [
          rule({
            ruleId: "other-vendor",
            categoryConfirmationCount: 10,
            vendorConfirmationCount: 10,
          }),
        ],
        aiSuggestedCategoryId: "meals",
      }),
    ).toEqual({
      categoryId: "meals",
      source: "ai",
      ruleId: null,
      confirmationCount: null,
      agreement: null,
    });

    expect(
      selectExpenseCategory({
        vendor: null,
        rules: [],
        aiSuggestedCategoryId: null,
      }).source,
    ).toBe("none");
  });

  it("rejects impossible confirmation evidence", () => {
    expect(() =>
      selectExpenseCategory({
        vendor: "Vendor",
        rules: [
          rule({
            vendor: "Vendor",
            categoryConfirmationCount: 4,
            vendorConfirmationCount: 3,
          }),
        ],
        aiSuggestedCategoryId: "other",
      }),
    ).toThrow();
  });
});

describe("expense allocation integrity", () => {
  it("accepts integer allocations only when they exactly equal the expense", () => {
    expect(
      validateExpenseAllocations({
        totalCents: 10_000,
        allocations: [
          { categoryId: "fuel", amountCents: 4_001 },
          { categoryId: "supplies", amountCents: 5_999 },
        ],
      }),
    ).toEqual({
      ok: true,
      allocationSet: {
        totalCents: 10_000,
        allocations: [
          { categoryId: "fuel", amountCents: 4_001 },
          { categoryId: "supplies", amountCents: 5_999 },
        ],
      },
    });
  });

  it.each([
    [9_999, "one cent short"],
    [10_001, "one cent over"],
  ])("rejects allocations totaling %i (%s)", (allocatedCents) => {
    const result = validateExpenseAllocations({
      totalCents: 10_000,
      allocations: [{ categoryId: "fuel", amountCents: allocatedCents }],
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ field: "allocations", code: "custom" }],
    });
  });

  it("rejects empty, zero, fractional, duplicate-category, and extra-field allocations", () => {
    for (const input of [
      { totalCents: 100, allocations: [] },
      {
        totalCents: 100,
        allocations: [{ categoryId: "fuel", amountCents: 0 }],
      },
      {
        totalCents: 100,
        allocations: [{ categoryId: "fuel", amountCents: 100.5 }],
      },
      {
        totalCents: 100,
        allocations: [
          { categoryId: "fuel", amountCents: 50 },
          { categoryId: "fuel", amountCents: 50 },
        ],
      },
      {
        totalCents: 100,
        allocations: [
          { categoryId: "fuel", amountCents: 100, percentage: 100 },
        ],
      },
    ]) {
      expect(ExpenseAllocationSetSchema.safeParse(input).success).toBe(false);
    }
  });
});
