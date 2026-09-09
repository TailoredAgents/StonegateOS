import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  collectPartnerReportCsv,
  downloadPartnerServiceReport,
} from "./portal-report-export";

void test("snapshot download preserves filters, strips pagination, and verifies checksum", async () => {
  const body = "date,amount\n2026-09-08,100";
  let calls = 0;
  const result = await downloadPartnerServiceReport({
    query: "kind=financial&po=PO-123&cursor=old&limit=25",
    format: "csv",
    fetcher: ((url: string) => {
      calls++;
      assert.match(url, /po=PO-123/u);
      assert.doesNotMatch(url, /cursor|limit/u);
      return Promise.resolve(new Response(body, {
        headers: {
          "content-type": "text/csv",
          "x-report-snapshot-sha256": "a".repeat(64),
          "x-content-sha256": createHash("sha256").update(body).digest("hex"),
        },
      }));
    }) as typeof fetch,
  });
  assert.equal(await result.text(), body);
  assert.equal(calls, 1);
});
void test("snapshot export refuses missing evidence or incomplete content", async () => {
  await assert.rejects(
    downloadPartnerServiceReport({
      query: "",
      format: "pdf",
      fetcher: (() => Promise.resolve(
        new Response("%PDF-truncated", {
          headers: {
            "content-type": "application/pdf",
            "x-report-snapshot-sha256": "a".repeat(64),
            "x-content-sha256": "b".repeat(64),
          },
        }))) as typeof fetch,
    }),
    /incomplete/u,
  );
  await assert.rejects(
    downloadPartnerServiceReport({
      query: "",
      format: "csv",
      fetcher: (() => Promise.resolve(
        new Response("csv", {
          headers: { "content-type": "text/csv" },
        }))) as typeof fetch,
    }),
    /could not be verified/u,
  );
});

void test("report export follows every cursor and writes exactly one header", async () => {
  const calls: string[] = [];
  const result = await collectPartnerReportCsv(((url: string) => {
    calls.push(url);
    return Promise.resolve(new Response(
      calls.length === 1
        ? "date,amount\r\n2026-09-01,100\r\n"
        : "date,amount\r\n2026-08-01,200\r\n",
      {
        headers: {
          "content-type": "text/csv",
          ...(calls.length === 1 ? { "x-next-cursor": "older-cursor" } : {}),
        },
      },
    ));
  }) as typeof fetch);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /cursor=older-cursor/u);
  assert.equal(result, "date,amount\r\n2026-09-01,100\r\n2026-08-01,200");
});
void test("report export refuses a partial download after a later-page failure", async () => {
  let page = 0;
  await assert.rejects(
    collectPartnerReportCsv((() => Promise.resolve(
      ++page === 1
        ? new Response("header\nrow", {
            headers: { "content-type": "text/csv", "x-next-cursor": "next" },
          })
        : new Response("unavailable", { status: 503 }))) as typeof fetch),
    /No partial file/u,
  );
});
void test("report export rejects loops and changing columns", async () => {
  await assert.rejects(
    collectPartnerReportCsv(
      (() => Promise.resolve(
        new Response("header\nrow", {
          headers: { "content-type": "text/csv", "x-next-cursor": "same" },
        }))) as typeof fetch,
    ),
    /fully paginated/u,
  );
  let page = 0;
  await assert.rejects(
    collectPartnerReportCsv(
      (() => Promise.resolve(
        new Response(++page === 1 ? "header\nrow" : "other\nrow", {
          headers: {
            "content-type": "text/csv",
            "x-next-cursor": String(page),
          },
        }))) as typeof fetch,
    ),
    /changed during export/u,
  );
});
