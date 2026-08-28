import { expect, test } from "../test";

test.describe("Mobile Spend V2", () => {
  test.use({
    storageState: "tests/e2e/storage/mobile-owner.json",
    serviceWorkers: "block",
  });

  test("coalesces receipt sync triggers into one upload", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "This workflow is covered by the mobile projects.");

    const browserErrors: string[] = [];
    let intentCount = 0;
    let uploadCount = 0;
    let finalizeCount = 0;
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.route("**/api/mobile/expenses/capabilities", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          capabilities: {
            manualEntry: true,
            receiptCapture: true,
            reimbursement: true,
            dailyAdSpend: false,
            overview: false,
            exactDuplicateReview: true,
            fixedCosts: false,
          },
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/categories", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          categories: [{ id: "fuel", name: "Fuel" }],
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/queue-health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      }),
    );
    await page.route("**/api/mobile/expenses/captures", async (route) => {
      expect(route.request().method()).toBe("POST");
      intentCount += 1;
      const body = route.request().postDataJSON() as {
        clientCaptureId: string;
      };
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: intentCount === 1 ? 201 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          capture: {
            id: "11111111-1111-4111-8111-111111111111",
            clientCaptureId: body.clientCaptureId,
            status: "awaiting_upload",
            version: 1,
          },
          uploadUrl: `/api/mobile/expenses/captures/${body.clientCaptureId}/upload`,
        }),
      });
    });
    await page.route(
      "**/api/mobile/expenses/captures/*/upload",
      async (route) => {
        expect(route.request().method()).toBe("PUT");
        uploadCount += 1;
        await route.fulfill({ status: 204 });
      },
    );
    await page.route(
      "**/api/mobile/expenses/captures/*/finalize",
      async (route) => {
        expect(route.request().method()).toBe("POST");
        finalizeCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            capture: {
              id: "11111111-1111-4111-8111-111111111111",
              status: "ready",
              version: 2,
              extraction: {
                review: {
                  fields: {
                    vendor: { value: "Test Fuel" },
                    transactionDate: { value: "2026-08-28" },
                    totalCents: { value: 1250 },
                    suggestedCategoryId: { value: "fuel" },
                  },
                  fieldsToCheck: [],
                },
              },
            },
          }),
        });
      },
    );

    await page.goto("/mobile?screen=expenses");
    await page.getByRole("button", { name: /^Scan receipt/u }).click();
    await page.getByLabel("Choose receipt photo or PDF").setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0V8AAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(
      page.getByRole("heading", { name: "Use this receipt?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Extract receipt details" }).click();
    await expect.poll(() => intentCount).toBe(1);

    await page.evaluate(() => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        window.dispatchEvent(
          new CustomEvent("stonegate:expense-queue-change", {
            detail: { employeeId: "mobile-owner" },
          }),
        );
        window.dispatchEvent(new Event("online"));
      }
    });

    await expect(
      page.getByRole("heading", { name: "Confirm every value" }),
    ).toBeVisible();
    await expect.poll(() => uploadCount).toBe(1);
    await expect.poll(() => finalizeCount).toBe(1);
    await page.waitForTimeout(250);

    expect(intentCount).toBe(1);
    expect(uploadCount).toBe(1);
    expect(finalizeCount).toBe(1);
    expect(browserErrors).toEqual([]);
  });

  test("keeps Add focused and exposes the essential manual and ad fields", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "This workflow is covered by the mobile projects.");

    const fixedCostSeriesId = "11111111-1111-4111-8111-111111111111";
    let linkedSubmissionSeen = false;
    let linkedApprovalSeen = false;

    await page.route("**/api/mobile/expenses/capabilities", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          capabilities: {
            manualEntry: true,
            receiptCapture: true,
            reimbursement: true,
            dailyAdSpend: true,
            overview: true,
            exactDuplicateReview: true,
            fixedCosts: true,
          },
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/categories", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          categories: [
            { id: "fuel", name: "Fuel" },
            { id: "supplies", name: "Supplies" },
            { id: "office_admin", name: "Office/Admin" },
          ],
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/fixed-costs?*", (route) => {
      const asOf = new URL(route.request().url()).searchParams.get("asOf");
      expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          currency: "USD",
          asOf,
          summary: {
            activeCount: 1,
            monthlyAmountCents: 310_000,
            dailyAccrualCents: 10_000,
          },
          costs: [
            {
              seriesId: fixedCostSeriesId,
              version: 1,
              name: "Office rent",
              categoryId: "office_admin",
              category: "Office/Admin",
              monthlyAmountCents: 310_000,
              effectiveStartDate: "2020-01-01",
              state: "active",
              createdAt: "2026-08-01T12:00:00.000Z",
            },
          ],
        }),
      });
    });
    await page.route("**/api/mobile/expenses/submissions", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body["coveredByFixedCostSeriesId"]).toBe(fixedCostSeriesId);
      expect(body["amountCents"]).toBe(310_000);
      expect(body["categoryId"]).toBe("office_admin");
      linkedSubmissionSeen = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: { reviewStatus: "approved" },
        }),
      });
    });
    await page.route("**/api/mobile/expenses/submissions?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          page: { limit: 40, hasMore: false, nextCursor: null },
          expenses: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              amountCents: 310_000,
              currency: "USD",
              categoryId: "office_admin",
              category: "Office/Admin",
              categoryNeedsReview: false,
              allocations: [
                {
                  categoryId: "office_admin",
                  category: "Office/Admin",
                  amountCents: 310_000,
                },
              ],
              vendor: "Stonegate Properties",
              notes: null,
              method: "ach",
              source: "receipt_scan",
              purchaseDate: "2026-07-27",
              payerType: "company",
              paidByMember: null,
              submitter: {
                id: "66666666-6666-4666-8666-666666666666",
                name: "Crew member",
              },
              reviewStatus: "pending",
              reviewer: null,
              reviewedAt: null,
              reviewReason: null,
              lifecycleStatus: "draft",
              version: 1,
              appointmentId: null,
              coveredByFixedCostSeriesId: null,
              coveredByFixedCostName: null,
              receipt: {
                captureId: "77777777-7777-4777-8777-777777777777",
                status: "awaiting_review",
                filename: "july-rent.pdf",
              },
              reimbursement: null,
              createdAt: "2026-07-27T12:00:00.000Z",
              updatedAt: "2026-07-27T12:00:00.000Z",
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              amountCents: 310_000,
              currency: "USD",
              categoryId: "office_admin",
              category: "Office/Admin",
              categoryNeedsReview: false,
              allocations: [
                {
                  categoryId: "office_admin",
                  category: "Office/Admin",
                  amountCents: 310_000,
                },
              ],
              vendor: "Stonegate Properties",
              notes: null,
              method: "ach",
              source: "receipt_scan",
              purchaseDate: "2026-08-27",
              payerType: "company",
              paidByMember: null,
              submitter: {
                id: "33333333-3333-4333-8333-333333333333",
                name: "Owner",
              },
              reviewStatus: "approved",
              reviewer: {
                id: "33333333-3333-4333-8333-333333333333",
                name: "Owner",
              },
              reviewedAt: "2026-08-27T12:00:00.000Z",
              reviewReason: null,
              lifecycleStatus: "posted",
              version: 2,
              appointmentId: null,
              coveredByFixedCostSeriesId: fixedCostSeriesId,
              coveredByFixedCostName: "Office rent",
              receipt: {
                captureId: "44444444-4444-4444-8444-444444444444",
                status: "confirmed",
                filename: "rent.pdf",
              },
              reimbursement: null,
              createdAt: "2026-08-27T12:00:00.000Z",
              updatedAt: "2026-08-27T12:00:00.000Z",
            },
          ],
        }),
      }),
    );
    await page.route(
      "**/api/mobile/expenses/submissions/*/review",
      async (route) => {
        expect(route.request().method()).toBe("POST");
        expect(route.request().headers()["idempotency-key"]).toBeTruthy();
        expect(route.request().headers()["if-match"]).toBe("1");
        const body = route.request().postDataJSON() as Record<string, unknown>;
        expect(body["decision"]).toBe("approve");
        expect(body["coveredByFixedCostSeriesId"]).toBe(fixedCostSeriesId);
        linkedApprovalSeen = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              reviewStatus: "approved",
              coveredByFixedCostSeriesId: fixedCostSeriesId,
            },
          }),
        });
      },
    );
    await page.route("**/api/mobile/expenses/captures?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          captures: [],
          page: { hasMore: false, nextCursor: null },
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/daily-ad-spend?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          businessDate: new URL(route.request().url()).searchParams.get(
            "businessDate",
          ),
          facebook: null,
          google: null,
        }),
      }),
    );

    await page.goto("/mobile?screen=expenses");

    await expect(
      page.getByRole("heading", {
        name: "Expenses without the paperwork pile",
      }),
    ).toBeVisible();
    for (const tab of ["Add", "Overview", "History"]) {
      const control = page.getByRole("button", { name: tab, exact: true });
      await expect(control).toBeVisible();
      expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        44,
      );
    }
    await expect(
      page.getByRole("button", { name: "Add", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    const addChoices = ["Scan receipt", "Daily ad spend", "Manual entry"];
    for (const name of addChoices) {
      const control = page.getByRole("button", {
        name: new RegExp(`^${name}`),
      });
      await expect(control).toBeVisible();
      expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        44,
      );
    }

    await page.getByRole("button", { name: /^Manual entry/u }).click();
    for (const name of addChoices) {
      await expect(
        page.getByRole("button", { name: new RegExp(`^${name}`) }),
      ).toHaveCount(0);
    }
    await expect(
      page.getByRole("heading", { name: "Enter the essentials" }),
    ).toBeVisible();
    await expect(page.getByLabel("Date", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Expense amount in dollars")).toBeVisible();
    const manualCategory = page.getByRole("combobox", {
      name: "Category",
      exact: true,
    });
    await expect(manualCategory).toBeVisible();
    await expect(page.getByText("Who paid?", { exact: true })).toBeVisible();
    await expect(page.getByText("More details", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("Already included as a fixed cost?"),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Post expense", exact: true }),
    ).toBeVisible();

    await page.getByLabel("Expense amount in dollars").fill("3100.00");
    await manualCategory.selectOption("office_admin");
    await page.getByText("More details", { exact: true }).click();
    const coverage = page.getByLabel("Already included as a fixed cost?");
    await expect(coverage).toBeVisible();
    await coverage.selectOption(fixedCostSeriesId);
    await expect(
      page.getByText(
        "This payment will not be counted a second time in Overview.",
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Post expense", exact: true })
      .click();
    await expect(
      page.getByText("Expense posted.", { exact: true }),
    ).toBeVisible();
    expect(linkedSubmissionSeen).toBe(true);

    await page.getByRole("button", { name: /^Daily ad spend/u }).click();
    await expect(page.getByLabel("Business date")).not.toHaveValue("");
    await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
    await expect(page.getByLabel("Facebook ad spend in dollars")).toBeVisible();
    await expect(page.getByLabel("Google ad spend in dollars")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save ad spend", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(
      page.getByText("Excluded from Overview — covered by Office rent", {
        exact: true,
      }),
    ).toBeVisible();
    const receiptLinks = page.getByRole("link", {
      name: "Receipt",
      exact: true,
    });
    await expect(receiptLinks).toHaveCount(2);
    await expect(receiptLinks.first()).toBeVisible();
    await expect(receiptLinks.last()).toBeVisible();

    await page.getByRole("button", { name: "Review", exact: true }).click();
    const approvalCoverage = page.getByLabel(
      "Already included as a fixed cost?",
    );
    await expect(approvalCoverage).not.toBeVisible();
    await page.getByText("Approval preferences", { exact: true }).click();
    await expect(approvalCoverage).toBeVisible();
    await approvalCoverage.selectOption(fixedCostSeriesId);
    await page
      .getByRole("button", { name: "Approve expense", exact: true })
      .click();
    await expect.poll(() => linkedApprovalSeen).toBe(true);
  });

  test("shows a truthful expense mix and keeps fixed-cost management focused", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "This workflow is covered by the mobile projects.");

    await page.route("**/api/mobile/expenses/capabilities", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          capabilities: {
            manualEntry: true,
            receiptCapture: false,
            reimbursement: true,
            dailyAdSpend: false,
            overview: true,
            exactDuplicateReview: false,
            fixedCosts: true,
          },
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/categories", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          categories: [
            { id: "insurance", name: "Insurance" },
            { id: "office_admin", name: "Office/Admin" },
          ],
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/overview?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          week: { startDate: "2026-08-24", endDate: "2026-08-30" },
          revenueCents: 80_000,
          ordinaryExpensesCents: 50_000,
          laborCents: 30_000,
          fixedCostsCents: 20_000,
          fixedCosts: {
            amountCents: 20_000,
            activeSeriesCount: 1,
            coveredExpenseCount: 1,
            coveredExpenseAmountCents: 310_000,
          },
          totalExpensesCents: 100_000,
          operatingProfitCents: -20_000,
          expenseRatioPercent: 125,
          priorWeek: {
            startDate: "2026-08-17",
            endDate: "2026-08-23",
            revenueCents: 100_000,
            ordinaryExpensesCents: 30_000,
            laborCents: 20_000,
            fixedCostsCents: 20_000,
            fixedCosts: {
              amountCents: 20_000,
              activeSeriesCount: 1,
              coveredExpenseCount: 0,
              coveredExpenseAmountCents: 0,
            },
            totalExpensesCents: 70_000,
            operatingProfitCents: 30_000,
            expenseRatioPercent: 70,
            pendingExpenseCount: 0,
            missingAdEntries: [],
            missingCommissionDataCount: 0,
            missingFinalTotalCount: 0,
            omittedUnverifiedHistoricalRecordCount: 0,
            unverifiedExpenseCategoryCount: 0,
            completeness: { state: "complete", reasons: [] },
          },
          priorWeekChange: {
            available: true,
            states: {
              revenue: "available",
              expenses: "available",
              operatingProfit: "available",
              expenseRatio: "available",
            },
            revenueCents: -20_000,
            revenuePercent: -20,
            expensesCents: 30_000,
            expensesPercent: 42.86,
            operatingProfitCents: -50_000,
            operatingProfitPercent: -166.67,
            expenseRatioPercentagePoints: 55,
            unavailableReasons: { currentWeek: [], priorWeek: [] },
          },
          categories: [
            ["labor", "Labor", 30_000, 30, 37.5],
            ["office_admin", "Office/Admin", 20_000, 20, 25],
            ["advertising", "Advertising", 15_000, 15, 18.75],
            ["fuel", "Fuel", 12_000, 12, 15],
            ["dump_fees", "Dump Fees", 10_000, 10, 12.5],
            ["software", "Software", 8_000, 8, 10],
            ["supplies", "Supplies", 5_000, 5, 6.25],
          ].map(
            ([
              id,
              label,
              amountCents,
              percentOfExpenses,
              percentOfRevenue,
            ]) => ({
              id,
              label,
              amountCents,
              percentOfExpenses,
              percentOfRevenue,
              verified: true,
            }),
          ),
          labor: {
            state: "actual",
            amountCents: 30_000,
            subrows: {
              crewCents: 20_000,
              salesCents: 5_000,
              managementCents: 5_000,
              otherPayrollAdjustmentsCents: 0,
            },
          },
          advertising: {
            amountCents: 15_000,
            subrows: { facebookCents: 10_000, googleCents: 5_000 },
            unattributedCents: 0,
          },
          pendingExpenseCount: 0,
          missingAdEntries: [],
          missingCommissionDataCount: 0,
          missingFinalTotalCount: 0,
          omittedUnverifiedHistoricalRecordCount: 0,
          unverifiedExpenseCategoryCount: 0,
          completeness: { state: "complete", reasons: [] },
        }),
      }),
    );

    type MockCost = {
      seriesId: string;
      version: number;
      name: string;
      categoryId: string;
      category: string;
      monthlyAmountCents: number;
      effectiveStartDate: string;
      state: "active" | "ended";
      createdAt: string;
    };
    const costs: MockCost[] = [
      {
        seriesId: "11111111-1111-4111-8111-111111111111",
        version: 1,
        name: "Office rent",
        categoryId: "office_admin",
        category: "Office/Admin",
        monthlyAmountCents: 310_000,
        effectiveStartDate: "2026-08-01",
        state: "active",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
    ];
    const fixedCostsPayload = () => ({
      ok: true,
      currency: "USD",
      asOf: "2026-08-27",
      summary: {
        activeCount: costs.filter((cost) => cost.state === "active").length,
        monthlyAmountCents: costs
          .filter((cost) => cost.state === "active")
          .reduce((sum, cost) => sum + cost.monthlyAmountCents, 0),
        dailyAccrualCents: costs
          .filter((cost) => cost.state === "active")
          .reduce(
            (sum, cost) => sum + Math.floor(cost.monthlyAmountCents / 31),
            0,
          ),
      },
      costs,
    });
    await page.route("**/api/mobile/expenses/fixed-costs", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        expect(request.headers()["idempotency-key"]).toBeTruthy();
        const body = request.postDataJSON() as {
          name: string;
          monthlyAmountCents: number;
          categoryId: string;
          effectiveStartDate: string;
        };
        costs.push({
          seriesId: "22222222-2222-4222-8222-222222222222",
          version: 1,
          name: body.name,
          categoryId: body.categoryId,
          category: "Insurance",
          monthlyAmountCents: body.monthlyAmountCents,
          effectiveStartDate: body.effectiveStartDate,
          state: "active",
          createdAt: "2026-08-27T12:00:00.000Z",
        });
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixedCostsPayload()),
      });
    });
    await page.route("**/api/mobile/expenses/fixed-costs/*", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("PATCH");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.headers()["if-match"]).toBeTruthy();
      const body = request.postDataJSON() as {
        action: "revise" | "end";
        expectedVersion: number;
        effectiveStartDate: string;
        name?: string;
        monthlyAmountCents?: number;
        categoryId?: string;
      };
      const cost = costs.find((candidate) =>
        request.url().includes(candidate.seriesId),
      );
      expect(cost).toBeTruthy();
      if (cost) {
        expect(body.expectedVersion).toBe(cost.version);
        cost.version += 1;
        cost.effectiveStartDate = body.effectiveStartDate;
        if (body.action === "end") {
          cost.state = "ended";
        } else {
          cost.name = body.name ?? cost.name;
          cost.monthlyAmountCents =
            body.monthlyAmountCents ?? cost.monthlyAmountCents;
          cost.categoryId = body.categoryId ?? cost.categoryId;
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/mobile?screen=expenses");
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(page.getByText("Loss after tracked costs")).toBeVisible();
    await expect(
      page.getByText(
        "1 linked payment totaling $3,100.00 remains in History and is excluded from ordinary expense totals.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Expense mix" }),
    ).toBeVisible();
    await expect(page.getByText("125.0%")).toBeVisible();
    const finalCategory = page
      .getByRole("listitem")
      .filter({ hasText: "Supplies" });
    await finalCategory.scrollIntoViewIfNeeded();
    await expect(finalCategory).toBeVisible();

    const manage = page.getByRole("button", { name: "Manage", exact: true });
    expect((await manage.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await manage.click();
    const fixedCostsHeading = page.getByRole("heading", {
      name: "Fixed costs",
      exact: true,
    });
    await expect(fixedCostsHeading).toBeVisible();
    await expect(fixedCostsHeading).toBeFocused();
    await expect(page.getByText("Office rent", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add fixed cost" }).click();
    await page.getByLabel("Name").fill("Insurance policy");
    await page.getByLabel("Monthly fixed cost in dollars").fill("620.00");
    await page.getByLabel("Category").selectOption("insurance");
    await page.getByRole("button", { name: "Add fixed cost" }).click();
    await expect(
      page.getByText("Insurance policy", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: /^Edit Insurance policy/u }).click();
    await page.getByLabel("Monthly fixed cost in dollars").fill("650.00");
    await page.getByRole("button", { name: "Save fixed cost change" }).click();
    await expect(page.getByText("$650.00", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^Edit Insurance policy/u }).click();
    await page.getByRole("button", { name: "End this fixed cost" }).click();
    await page.getByRole("button", { name: "Confirm end date" }).click();
    await expect(page.getByText("Past fixed costs (1)")).toBeVisible();
    await page.getByRole("button", { name: "Back to Overview" }).click();
    await expect(
      page.getByRole("button", { name: "Manage", exact: true }),
    ).toBeFocused();
  });
});
