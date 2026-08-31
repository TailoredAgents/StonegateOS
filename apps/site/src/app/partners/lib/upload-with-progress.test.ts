import assert from "node:assert/strict";
import test from "node:test";
import {
  PortalFileUploadError,
  uploadPortalFileWithProgress,
} from "./upload-with-progress";

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
    this.emit("load");
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

test("uploads the selected file with intent headers and reports real byte progress", async () => {
  const restore = installFakeRequest();
  const file = { size: 10 } as File;
  const progress: number[] = [];
  FakeXmlHttpRequest.responseStatus = 204;
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

test("rejects a non-success storage response without reporting completion", async () => {
  const restore = installFakeRequest();
  const progress: number[] = [];
  FakeXmlHttpRequest.responseStatus = 403;
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
