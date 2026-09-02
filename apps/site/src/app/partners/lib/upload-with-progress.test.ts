import assert from "node:assert/strict";
import test from "node:test";
import {
  PortalFileUploadError,
  shouldCompressPortalImage,
  uploadPortalFileWithProgress,
} from "./upload-with-progress";

void test("compresses only large browser-decodable images", () => {
  assert.equal(
    shouldCompressPortalImage({
      contentType: "image/jpeg",
      byteLength: 2 * 1024 * 1024,
    }),
    true,
  );
  assert.equal(
    shouldCompressPortalImage({
      contentType: "image/heic",
      byteLength: 8 * 1024 * 1024,
    }),
    false,
  );
  assert.equal(
    shouldCompressPortalImage({
      contentType: "image/png",
      byteLength: 512 * 1024,
    }),
    false,
  );
});

type Listener = (event: ProgressEvent) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: Partial<ProgressEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as ProgressEvent);
    }
  }
}

class FakeXmlHttpRequest extends FakeEventTarget {
  static responseStatus = 204;
  static responseEvent: "load" | "abort" | "error" | "timeout" = "load";
  static last: FakeXmlHttpRequest | null = null;

  readonly upload = new FakeEventTarget();
  readonly headers = new Map<string, string>();
  method = "";
  url = "";
  async = false;
  timeout = 0;
  status = 0;
  sentBody: Document | XMLHttpRequestBodyInit | null = null;

  constructor() {
    super();
    FakeXmlHttpRequest.last = this;
  }

  open(method: string, url: string, async: boolean): void {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.sentBody = body;
    this.upload.emit("progress", {
      lengthComputable: true,
      loaded: 5,
      total: 10,
    });
    this.status = FakeXmlHttpRequest.responseStatus;
    this.emit(FakeXmlHttpRequest.responseEvent);
  }

  abort(): void {
    this.emit("abort");
  }
}

function installFakeRequest(): () => void {
  const target = globalThis as unknown as {
    XMLHttpRequest?: typeof XMLHttpRequest;
  };
  const original = target.XMLHttpRequest;
  target.XMLHttpRequest =
    FakeXmlHttpRequest as unknown as typeof XMLHttpRequest;
  return () => {
    target.XMLHttpRequest = original;
  };
}

void test("uploads the selected file with intent headers and reports real byte progress", async () => {
  const restore = installFakeRequest();
  const file = { size: 10 } as File;
  const progress: number[] = [];
  FakeXmlHttpRequest.responseStatus = 204;
  FakeXmlHttpRequest.responseEvent = "load";
  try {
    await uploadPortalFileWithProgress({
      url: "https://storage.test/private-upload",
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "X-Upload": "intent" },
      file,
      onProgress: (event) => progress.push(event.percent),
    });
  } finally {
    restore();
  }

  const request = FakeXmlHttpRequest.last;
  assert.ok(request);
  assert.equal(request.method, "PUT");
  assert.equal(request.url, "https://storage.test/private-upload");
  assert.equal(request.async, true);
  assert.equal(request.headers.get("Content-Type"), "image/jpeg");
  assert.equal(request.headers.get("X-Upload"), "intent");
  assert.equal(request.sentBody, file);
  assert.deepEqual(progress, [0, 50, 100]);
});

void test("rejects a non-success storage response without reporting completion", async () => {
  const restore = installFakeRequest();
  const progress: number[] = [];
  FakeXmlHttpRequest.responseStatus = 403;
  FakeXmlHttpRequest.responseEvent = "load";
  try {
    await assert.rejects(
      uploadPortalFileWithProgress({
        url: "https://storage.test/expired-intent",
        method: "PUT",
        headers: {},
        file: { size: 10 } as File,
        onProgress: (event) => progress.push(event.percent),
      }),
      (error) =>
        error instanceof PortalFileUploadError &&
        error.code === "storage_upload_failed",
    );
  } finally {
    restore();
  }
  assert.deepEqual(progress, [0, 50]);
});

void test("an interrupted storage request rejects promptly without reporting completion", async () => {
  const restore = installFakeRequest();
  const progress: number[] = [];
  FakeXmlHttpRequest.responseStatus = 0;
  FakeXmlHttpRequest.responseEvent = "abort";
  try {
    await assert.rejects(
      uploadPortalFileWithProgress({
        url: "https://storage.test/interrupted-intent",
        method: "PUT",
        headers: {},
        file: { size: 10 } as File,
        onProgress: (event) => progress.push(event.percent),
      }),
      (error) =>
        error instanceof PortalFileUploadError &&
        error.code === "storage_upload_interrupted",
    );
  } finally {
    FakeXmlHttpRequest.responseEvent = "load";
    restore();
  }
  assert.deepEqual(progress, [0, 50]);
});
