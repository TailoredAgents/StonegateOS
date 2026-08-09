import { Buffer } from "node:buffer";
import {
  OUTBOUND_IMPORT_MAX_BYTES,
  OUTBOUND_IMPORT_MAX_REQUEST_BYTES,
  buildOutboundImportExclusionReport,
  classifyOutboundExistingIdentity,
  hashOutboundImportPreview,
  parseOutboundImportPayload,
  readOutboundImportJsonRequest,
  type OutboundImportPublicRow,
} from "@/lib/outbound-import";
import { runOutboundImportAtomic } from "@/lib/outbound-import-transaction";
import {
  readBoundedRequestBytes,
  type BoundedRequestBodyError,
} from "../../../site/src/app/team/lib/bounded-request";
import {
  parseOutboundImportMutationSuccess,
  parseOutboundImportPreviewEnvelope,
} from "../../../site/src/app/team/lib/outbound-import-result";

function payload(csv: string, extra: Record<string, unknown> = {}): unknown {
  return {
    csvBase64: Buffer.from(csv, "utf8").toString("base64"),
    campaign: "property_management",
    assignedToMemberId: "11111111-1111-4111-8111-111111111111",
    ...extra,
  };
}

describe("Outbound import CSV normalization", () => {
  it("accepts UTF-8 BOM, supported aliases, and quoted commas", () => {
    const parsed = parseOutboundImportPayload(
      payload(
        '\uFEFFCompany Name,Full Name,Email Address,Mobile Phone,Extra\r\n"Acme, LLC",Jane Doe,JANE@EXAMPLE.COM,(404) 555-0101,ignored',
      ),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 2,
      company: "Acme, LLC",
      contactName: "Jane Doe",
      emailNormalized: "jane@example.com",
      phoneE164: "+14045550101",
      preflightStatus: "candidate",
    });
    expect(parsed.ignoredHeaders).toEqual(["Extra"]);
  });

  it("accepts exactly 2,000 data rows and rejects 2,001 before execution", () => {
    const csvFor = (count: number) =>
      [
        "email,company",
        ...Array.from(
          { length: count },
          (_, index) => `person${index}@example.com,Company ${index}`,
        ),
      ].join("\n");
    expect(
      parseOutboundImportPayload(payload(csvFor(2_000))).rows,
    ).toHaveLength(2_000);
    expect(() => parseOutboundImportPayload(payload(csvFor(2_001)))).toThrow(
      /maximum is 2,000/u,
    );
  });

  it("deduplicates deterministically by normalized email or phone", () => {
    const parsed = parseOutboundImportPayload(
      payload(
        [
          "email,phone,company",
          "JANE@example.com,4045550101,First",
          " jane@example.com ,4045550102,Duplicate email",
          "other@example.com,(404) 555-0101,Duplicate phone",
        ].join("\n"),
      ),
    );
    expect(parsed.rows.map((row) => row.preflightStatus)).toEqual([
      "candidate",
      "duplicate",
      "duplicate",
    ]);
    expect(parsed.rows[1]?.duplicateOfRow).toBe(2);
    expect(parsed.rows[2]?.duplicateOfRow).toBe(2);
  });

  it("deduplicates a later row that bridges two earlier identity roots", () => {
    const parsed = parseOutboundImportPayload(
      payload(
        [
          "email,phone,company",
          "first@example.com,4045550101,First root",
          "second@example.com,4045550102,Second root",
          "first@example.com,4045550102,Bridge",
        ].join("\n"),
      ),
    );
    expect(parsed.rows.map((row) => row.preflightStatus)).toEqual([
      "candidate",
      "duplicate",
      "duplicate",
    ]);
    expect(parsed.rows.map((row) => row.duplicateOfRow)).toEqual([null, 2, 2]);
  });

  it("keeps alternate identifiers on an earlier duplicate in the same cluster", () => {
    const parsed = parseOutboundImportPayload(
      payload(
        [
          "email,phone,company",
          "first@example.com,4045550101,Canonical",
          "first@example.com,4045550102,Duplicate with alternate phone",
          "second@example.com,4045550102,Connected through duplicate",
        ].join("\n"),
      ),
    );
    expect(parsed.rows.map((row) => row.preflightStatus)).toEqual([
      "candidate",
      "duplicate",
      "duplicate",
    ]);
    expect(parsed.rows.map((row) => row.duplicateOfRow)).toEqual([null, 2, 2]);
  });

  it("rejects invalid UTF-8, missing identity headers, and oversized input", () => {
    expect(() =>
      parseOutboundImportPayload({
        csvBase64: Buffer.from([0xff, 0xfe]).toString("base64"),
      }),
    ).toThrow(/valid UTF-8/u);
    expect(() =>
      parseOutboundImportPayload(payload("company,name\nAcme,Jane")),
    ).toThrow(/email or phone header/u);
    expect(() =>
      parseOutboundImportPayload({
        csvBase64: Buffer.alloc(OUTBOUND_IMPORT_MAX_BYTES + 1, 65).toString(
          "base64",
        ),
      }),
    ).toThrow(/exceeds/u);
  });
});

describe("Outbound import request body bounds", () => {
  function streamRequest(
    chunks: readonly Uint8Array[],
    headers: HeadersInit,
  ): Request {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Request("http://localhost/import", {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  it("rejects an oversized declared API JSON body before reading its stream", async () => {
    let readerRequested = false;
    const request = {
      headers: new Headers({
        "content-type": "application/json",
        "content-length": String(OUTBOUND_IMPORT_MAX_REQUEST_BYTES + 1),
      }),
      body: {
        getReader() {
          readerRequested = true;
          throw new Error("must_not_read");
        },
      },
    } as unknown as Request;
    await expect(readOutboundImportJsonRequest(request)).rejects.toThrow(
      /exceeds/u,
    );
    expect(readerRequested).toBe(false);
  });

  it("rejects a streamed API JSON body that exceeds the limit without Content-Length", async () => {
    const oneMiB = new Uint8Array(1024 * 1024);
    const request = streamRequest(
      [oneMiB, oneMiB, oneMiB, new Uint8Array([1])],
      { "content-type": "application/json" },
    );
    await expect(readOutboundImportJsonRequest(request)).rejects.toThrow(
      /exceeds/u,
    );
  });

  it("parses a bounded JSON request and a bounded multipart proxy body", async () => {
    const json = new TextEncoder().encode('{"campaign":"test"}');
    await expect(
      readOutboundImportJsonRequest(
        streamRequest([json], {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(json.byteLength),
        }),
      ),
    ).resolves.toEqual({ campaign: "test" });

    const proxyBytes = new TextEncoder().encode("bounded");
    await expect(
      readBoundedRequestBytes(
        streamRequest([proxyBytes], {
          "content-length": String(proxyBytes.byteLength),
        }),
        proxyBytes.byteLength,
      ),
    ).resolves.toEqual(proxyBytes);
  });

  it("caps the Site proxy stream even when Content-Length is absent", async () => {
    await expect(
      readBoundedRequestBytes(
        streamRequest(
          [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8, 9])],
          {},
        ),
        8,
      ),
    ).rejects.toMatchObject<Partial<BoundedRequestBodyError>>({
      reason: "too_large",
    });
  });

  it("rejects an oversized declared Site proxy body before reading it", async () => {
    let readerRequested = false;
    const request = {
      headers: new Headers({ "content-length": "9" }),
      body: {
        getReader() {
          readerRequested = true;
          throw new Error("must_not_read");
        },
      },
    } as unknown as Request;
    await expect(readBoundedRequestBytes(request, 8)).rejects.toMatchObject({
      reason: "too_large",
    });
    expect(readerRequested).toBe(false);
  });
});

describe("Outbound identity and report safety", () => {
  it("classifies a split email/phone identity as a conflict", () => {
    const emailContact = {
      id: "contact-a",
      emailNormalized: "jane@example.com",
      phoneE164: "+14045550101",
      deleted: false,
    };
    const phoneContact = {
      id: "contact-b",
      emailNormalized: "other@example.com",
      phoneE164: "+14045550102",
      deleted: false,
    };
    expect(
      classifyOutboundExistingIdentity({
        emailNormalized: "jane@example.com",
        phoneE164: "+14045550102",
        emailMatches: [emailContact],
        phoneMatches: [phoneContact],
      }),
    ).toEqual({
      kind: "conflict",
      reason: "Email and phone map to different existing contacts.",
      contactId: null,
    });
  });

  it("neutralizes spreadsheet formulas without truncating exclusions", () => {
    const rows: OutboundImportPublicRow[] = [
      {
        rowNumber: 2,
        status: "invalid",
        reason: "+unsafe reason",
        duplicateOfRow: null,
        existingContactId: null,
        company: "=CMD()",
        contactName: "@person",
        email: null,
        phone: null,
        plannedChanges: [],
      },
      {
        rowNumber: 3,
        status: "conflict",
        reason: "-unsafe reason",
        duplicateOfRow: null,
        existingContactId: "contact-a",
        company: "Safe",
        contactName: null,
        email: "safe@example.com",
        phone: null,
        plannedChanges: [],
      },
    ];
    const report = buildOutboundImportExclusionReport(rows, "a".repeat(64));
    expect(report).toMatchObject({ rowCount: 2, truncated: false });
    expect(report.csv).toContain("'=CMD()");
    expect(report.csv).toContain("'@person");
    expect(report.csv).toContain("'+unsafe reason");
    expect(report.csv).toContain("'-unsafe reason");
    expect(report.csv.split("\r\n")).toHaveLength(4);
  });

  it("binds the preview hash to exact linked-record changes", () => {
    const row: OutboundImportPublicRow = {
      rowNumber: 2,
      status: "create",
      reason: null,
      duplicateOfRow: null,
      existingContactId: null,
      company: "Acme",
      contactName: "Jane",
      email: "jane@example.com",
      phone: null,
      plannedChanges: ["contact.create", "pipeline.create"],
    };
    const common = {
      requestHash: "a".repeat(64),
      assigneeMemberId: "member",
    };
    expect(hashOutboundImportPreview({ ...common, rows: [row] })).not.toBe(
      hashOutboundImportPreview({
        ...common,
        rows: [
          {
            ...row,
            plannedChanges: ["contact.create", "task.create"],
          },
        ],
      }),
    );
  });
});

describe("Outbound import Site response validation", () => {
  const hash = "b".repeat(64);
  const counts = {
    total: 1,
    accepted: 1,
    create: 1,
    update: 0,
    unchanged: 0,
    invalid: 0,
    duplicate: 0,
    conflict: 0,
  };
  const report = {
    rowCount: 0,
    truncated: false as const,
    filename: "outbound-import-exclusions.csv",
    csv: '"row_number","status","reason"\r\n',
  };
  const row = {
    rowNumber: 2,
    status: "create",
    reason: null,
    duplicateOfRow: null,
    existingContactId: null,
    company: "Acme",
    contactName: "Jane",
    email: "jane@example.com",
    phone: null,
    plannedChanges: ["contact.create"],
  };

  it("rejects malformed or truncated preview successes", () => {
    const valid = {
      ok: true,
      preview: {
        kind: "outbound_import_preview",
        requestHash: "a".repeat(64),
        previewHash: hash,
        campaign: "property_management",
        assignee: { id: "member", name: "Sales" },
        byteLength: 100,
        ignoredHeaders: [],
        counts,
        confirmationPhrase: "IMPORT 1",
        rows: [row],
        exclusionReport: report,
      },
    };
    expect(parseOutboundImportPreviewEnvelope(valid)?.previewHash).toBe(hash);
    expect(
      parseOutboundImportPreviewEnvelope({
        ...valid,
        preview: { ...valid.preview, rows: [] },
      }),
    ).toBeNull();
    expect(
      parseOutboundImportPreviewEnvelope({
        ...valid,
        preview: {
          ...valid.preview,
          rows: [{ ...row, plannedChanges: ["unsupported.change"] }],
        },
      }),
    ).toBeNull();
    expect(
      parseOutboundImportPreviewEnvelope({
        ...valid,
        preview: {
          ...valid.preview,
          exclusionReport: { ...report, truncated: true },
        },
      }),
    ).toBeNull();
  });

  it("requires a transaction audit receipt bound to the exact preview hash", () => {
    const valid = {
      ok: true,
      data: {
        kind: "outbound_import_result",
        requestHash: "a".repeat(64),
        previewHash: hash,
        campaign: "property_management",
        assignee: { id: "member", name: "Sales" },
        counts: {
          ...counts,
          rowsUpdated: 0,
          contactsCreated: 1,
          contactsModified: 0,
          partnerAccountsResolved: 0,
          partnerLinksCreated: 0,
          contactNotesCreated: 0,
          tasksCreated: 1,
          pipelineRowsCreated: 1,
        },
        exclusionReport: report,
      },
      receipt: {
        operationId: "operation",
        correlationId: "correlation",
        actorId: "actor",
        committedAt: "2026-08-08T12:00:00.000Z",
        auditEventId: "audit",
        entityType: "outbound_import",
        entityId: hash,
        version: hash,
      },
    };
    expect(parseOutboundImportMutationSuccess(valid, hash)).not.toBeNull();
    expect(
      parseOutboundImportMutationSuccess(
        {
          ...valid,
          receipt: { ...valid.receipt, auditEventId: "" },
        },
        hash,
      ),
    ).toBeNull();
    for (const [counter, value] of [
      ["partnerAccountsResolved", 2],
      ["partnerLinksCreated", 2],
      ["contactNotesCreated", 2],
    ] as const) {
      expect(
        parseOutboundImportMutationSuccess(
          {
            ...valid,
            data: {
              ...valid.data,
              counts: { ...valid.data.counts, [counter]: value },
            },
          },
          hash,
        ),
      ).toBeNull();
    }
    expect(
      parseOutboundImportMutationSuccess(valid, "c".repeat(64)),
    ).toBeNull();
    expect(
      parseOutboundImportMutationSuccess(
        {
          ...valid,
          data: {
            ...valid.data,
            counts: { ...valid.data.counts, rowsUpdated: 1 },
          },
        },
        hash,
      ),
    ).toBeNull();
    expect(
      parseOutboundImportMutationSuccess(
        {
          ...valid,
          data: {
            ...valid.data,
            counts: { ...valid.data.counts, contactsModified: 1 },
          },
        },
        hash,
      ),
    ).toBeNull();
    expect(
      parseOutboundImportMutationSuccess(
        {
          ...valid,
          data: {
            ...valid.data,
            exclusionReport: {
              ...valid.data.exclusionReport,
              csv: `${valid.data.exclusionReport.csv}"unexpected"\r\n`,
            },
          },
        },
        hash,
      ),
    ).toBeNull();
  });
});

describe("Outbound import atomic orchestration", () => {
  type State = {
    contacts: string[];
    tasks: string[];
    audits: string[];
    receipts: string[];
  };

  function transactionalHarness(state: State) {
    return async <Result>(
      work: (draft: State) => Promise<Result>,
    ): Promise<Result> => {
      const draft = structuredClone(state);
      const result = await work(draft);
      state.contacts = draft.contacts;
      state.tasks = draft.tasks;
      state.audits = draft.audits;
      state.receipts = draft.receipts;
      return result;
    };
  }

  it("rolls back earlier record writes when a later transaction step fails", async () => {
    const state: State = { contacts: [], tasks: [], audits: [], receipts: [] };
    await expect(
      runOutboundImportAtomic(transactionalHarness(state), (tx) => {
        tx.contacts.push("contact-1");
        tx.tasks.push("task-1");
        return Promise.reject(new Error("audit_failed"));
      }),
    ).rejects.toThrow("audit_failed");
    expect(state).toEqual({
      contacts: [],
      tasks: [],
      audits: [],
      receipts: [],
    });
  });

  it("does not expose a partial receipt when terminal ledger completion fails", async () => {
    const state: State = { contacts: [], tasks: [], audits: [], receipts: [] };
    await expect(
      runOutboundImportAtomic(transactionalHarness(state), (tx) => {
        tx.contacts.push("contact-1");
        tx.audits.push("audit-1");
        tx.receipts.push("receipt-before-ledger-verification");
        return Promise.reject(new Error("ledger_completion_failed"));
      }),
    ).rejects.toThrow("ledger_completion_failed");
    expect(state).toEqual({
      contacts: [],
      tasks: [],
      audits: [],
      receipts: [],
    });
  });
});
