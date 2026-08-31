import {
  generateQuoteV2Number,
  withCollisionSafeQuoteNumber,
} from "@/lib/quote-v2-number";

describe("quote V2 numbers", () => {
  it("creates readable date-prefixed, collision-resistant numbers", () => {
    const number = generateQuoteV2Number(new Date("2026-08-30T12:00:00.000Z"));
    expect(number).toMatch(/^Q-20260830-[23456789A-HJ-NP-Z]{8}$/u);
  });

  it("retries only unique violations and returns the committed candidate", async () => {
    const candidates = [
      "Q-20260830-COLLIDE1",
      "Q-20260830-COLLIDE2",
      "Q-20260830-NEWQUOTE",
    ];
    let attempts = 0;
    await expect(
      withCollisionSafeQuoteNumber({
        now: new Date("2026-08-30T12:00:00.000Z"),
        generate: () => candidates[attempts] ?? "Q-20260830-FALLBACK",
        write: (number) => {
          attempts += 1;
          if (attempts < 3) {
            const collision = new Error("duplicate quote number") as Error & {
              code: string;
            };
            collision.code = "23505";
            return Promise.reject(collision);
          }
          return Promise.resolve(number);
        },
      }),
    ).resolves.toBe("Q-20260830-NEWQUOTE");
    expect(attempts).toBe(3);
  });

  it("does not retry unrelated database failures", async () => {
    let attempts = 0;
    await expect(
      withCollisionSafeQuoteNumber({
        write: () => {
          attempts += 1;
          return Promise.reject(new Error("connection unavailable"));
        },
      }),
    ).rejects.toThrow("connection unavailable");
    expect(attempts).toBe(1);
  });
});
