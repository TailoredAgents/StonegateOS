# Private Expense Receipt Benchmark

Keep the manifest and receipt files outside the repository in a private,
access-controlled directory. Do not commit the corpus, manifest, or any
receipt-level output.

The manifest is strict JSON:

```json
{
  "schemaVersion": 1,
  "representativeCorpusReviewed": true,
  "groundTruthReviewed": true,
  "receipts": [
    {
      "id": "receipt-001",
      "file": "receipts/001.jpg",
      "contentType": "image/jpeg",
      "expected": {
        "totalCents": 1234,
        "transactionDate": "2026-08-26",
        "vendor": "Example Vendor"
      }
    }
  ]
}
```

Use at least 100 receipts. IDs and relative file names must be unique. Every
total, date, and vendor must be human-reviewed, exact ground truth. The two
top-level review flags are an explicit sign-off that the corpus is
representative and its labels were checked.

First validate the complete manifest, paths, byte signatures, MIME types,
sizes, hashes, and image normalization. This mode makes no API requests:

```sh
pnpm expense-receipt:benchmark -- --manifest=/private/receipts/manifest.json
```

The aggregate validation report gives the count-bound confirmation token. A
live run also requires `OPENAI_API_KEY` and an explicit model. Keep
`OPENAI_API_BASE_URL` unset; the harness refuses non-official endpoints. For a
validated 100-receipt corpus, run:

```sh
pnpm expense-receipt:benchmark -- \
  --manifest=/private/receipts/manifest.json \
  --execute-live \
  --model=gpt-4.1-mini-2025-04-14 \
  --confirm-live=RUN_PRIVATE_RECEIPT_BENCHMARK_100
```

Use the exact approved model identifier for every comparable run. Live mode
makes one sequential Responses API request per receipt through the production
extractor with provider storage disabled. Provider or schema failures count as
misses; there are no automatic retries.

Only aggregate JSON is printed: corpus count, analyzed/failure counts, model,
thresholds, exact-match percentages, and pass/fail. Receipt contents, paths,
IDs, vendors, and provider error text are never printed. The rollout gate
passes only at 98% exact totals and 95% exact transaction dates and vendors.
