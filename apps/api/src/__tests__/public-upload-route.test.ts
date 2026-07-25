import type { NextRequest } from "next/server";
import { POST } from "../../app/api/public/junk-quote/uploads/route";

describe("public instant-quote upload admission", () => {
  const originalStaffMediaWrites =
    process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"];
  const originalPublicMediaUploads =
    process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"];

  beforeEach(() => {
    process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"] = "0";
    process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"] = "1";
  });

  afterAll(() => {
    if (originalStaffMediaWrites === undefined) {
      delete process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"];
    } else {
      process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"] =
        originalStaffMediaWrites;
    }
    if (originalPublicMediaUploads === undefined) {
      delete process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"];
    } else {
      process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"] =
        originalPublicMediaUploads;
    }
  });

  it("does not let the staff-media switch enable public uploads", async () => {
    process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"] = "1";
    process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"] = "0";
    const formData = jest.fn();
    const request = {
      headers: new Headers({
        "content-length": "100",
        "content-type": "multipart/form-data; boundary=test-boundary",
      }),
      formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe("media_writes_disabled");
    expect(formData).not.toHaveBeenCalled();
  });

  it("rejects a body without a valid Content-Length before parsing multipart data", async () => {
    const formData = jest.fn();
    const request = {
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=test-boundary",
      }),
      formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(411);
    expect(body.error).toBe("content_length_required");
    expect(formData).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body before parsing multipart data", async () => {
    const formData = jest.fn();
    const request = {
      headers: new Headers({
        "content-length": String(102 * 1024 * 1024),
        "content-type": "multipart/form-data; boundary=test-boundary",
      }),
      formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(413);
    expect(body.error).toBe("request_too_large");
    expect(formData).not.toHaveBeenCalled();
  });
});
