import type { NextRequest } from "next/server";

const mockIsAdminRequest = jest.fn();
const mockRequirePermission = jest.fn();
const mockGetDb = jest.fn();
const mockFetchTwilioProviderMedia = jest.fn();
const mockLimit = jest.fn();

jest.mock("drizzle-orm", () => ({
  eq: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  conversationMessages: {
    id: "conversation_messages.id",
    mediaUrls: "conversation_messages.media_urls",
    provider: "conversation_messages.provider",
  },
  getDb: mockGetDb,
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/twilio-provider", () => ({
  fetchTwilioProviderMedia: mockFetchTwilioProviderMedia,
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));

import {
  GET,
  HEAD,
} from "../../app/api/admin/inbox/messages/[messageId]/media/[index]/route";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

function request(): NextRequest {
  const url = new URL(
    "https://api.example.test/api/admin/inbox/messages/message-1/media/0",
  );
  const value = new Request(url);
  Object.defineProperty(value, "nextUrl", { value: url });
  return value as unknown as NextRequest;
}

function trackedContext(): {
  context: Parameters<typeof GET>[1];
  readParams: jest.Mock;
} {
  const readParams = jest.fn(() =>
    Promise.resolve({ messageId: "message-1", index: "0" }),
  );
  const context = {} as Parameters<typeof GET>[1];
  Object.defineProperty(context, "params", { get: readParams });
  return { context, readParams };
}

function headers(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

describe("Inbox media route authorization boundary", () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchSpy = jest.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("public media must not be fetched in this test"),
    );
    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockLimit.mockResolvedValue([
      {
        provider: "twilio",
        mediaUrls: ["https://api.twilio.test/media/message-1/0"],
      },
    ]);
    mockGetDb.mockReturnValue({
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({ limit: mockLimit })),
        })),
      })),
    });
    mockFetchTwilioProviderMedia.mockResolvedValue({
      ok: true,
      buffer: png,
      declaredContentType: "image/png",
      filename: "customer photo.png",
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it.each([
    ["HEAD", HEAD],
    ["GET", GET],
  ])(
    "%s rejects an unverified request before parameters, database, or media access",
    async (_method, handler) => {
      mockIsAdminRequest.mockReturnValue(false);
      const { context, readParams } = trackedContext();

      const response = await handler(request(), context);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
      expect(mockRequirePermission).not.toHaveBeenCalled();
      expect(readParams).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockFetchTwilioProviderMedia).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["HEAD", HEAD],
    ["GET", GET],
  ])(
    "%s rejects a missing messages.read grant before parameters, database, or media access",
    async (_method, handler) => {
      mockRequirePermission.mockResolvedValue(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );
      const mediaRequest = request();
      const { context, readParams } = trackedContext();

      const response = await handler(mediaRequest, context);

      expect(response.status).toBe(403);
      expect(mockRequirePermission).toHaveBeenCalledWith(
        mediaRequest,
        "messages.read",
      );
      expect(readParams).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockFetchTwilioProviderMedia).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("keeps authorized HEAD and GET headers identical while omitting only the HEAD body", async () => {
    const headContext = trackedContext();
    const getContext = trackedContext();

    const head = await HEAD(request(), headContext.context);
    const get = await GET(request(), getContext.context);

    expect(head.status).toBe(200);
    expect(get.status).toBe(200);
    expect(headers(head)).toEqual(headers(get));
    expect(head.headers.get("content-length")).toBe(String(png.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(png);
    expect(mockRequirePermission).toHaveBeenCalledTimes(2);
    expect(mockFetchTwilioProviderMedia).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(mockRequirePermission.mock.invocationCallOrder[0]).toBeLessThan(
      headContext.readParams.mock.invocationCallOrder[0]!,
    );
    expect(mockRequirePermission.mock.invocationCallOrder[1]).toBeLessThan(
      getContext.readParams.mock.invocationCallOrder[0]!,
    );
  });
});
