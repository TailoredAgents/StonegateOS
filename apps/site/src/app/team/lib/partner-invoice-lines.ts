import type { PartnerQuoteServiceSeed } from "./quote-v2-composer-model";

export type PartnerInvoiceDraftRow = {
  key: string;
  description: string;
  quantity: string;
  unitAmountCents: number | null;
};

export function partnerInvoiceRowsForJob(job: {
  id: string;
  service: string | null;
  totalCents: number | null;
  serviceLines?: readonly PartnerQuoteServiceSeed[];
}): PartnerInvoiceDraftRow[] {
  if (job.serviceLines?.length)
    return job.serviceLines.map((line) => {
      const full = `${line.title}\n${line.description}`;
      return {
        key: `${job.id}:${line.id}`,
        description: full.length <= 1000 ? full : line.title,
        quantity: "1",
        unitAmountCents: line.amountCents,
      };
    });
  return [
    {
      key: `${job.id}:service`,
      description: job.service || "Service",
      quantity: "1",
      unitAmountCents: job.totalCents,
    },
  ];
}
