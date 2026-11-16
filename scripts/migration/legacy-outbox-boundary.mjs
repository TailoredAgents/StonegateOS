// Rehearsal primitive for an old worker without a drain hook. A loopback-only
// Inspector breakpoint waits before the NEXT batch, after the prior batch and
// awaited schedulers finish. This does not itself suspend/replace any service.
// Never start another consumer on the strength of a paused process alone:
// disconnecting a debugger may resume it. Confirm provider suspension first.
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";

export async function holdLegacyOutboxBoundary({
  websocket,
  pid,
  filename,
  sha256,
  timeoutMs = 60000,
  holdMs = 60000,
}) {
  const endpoint = new URL(websocket);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !filename.startsWith("/") ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isFinite(timeoutMs) ||
    !Number.isFinite(holdMs) ||
    timeoutMs < 100 ||
    timeoutMs > 120000 ||
    holdMs < 100 ||
    holdMs > 120000
  )
    throw Error("Invalid bounded loopback Inspector target");
  const socket = new WebSocket(websocket);
  const requests = new Map();
  const scripts = new Map();
  let nextId = 0;
  let paused;
  let breakpointId;
  let pauseResolve;
  let pauseReject;
  let timer;
  const ownsPause = () =>
    Boolean(breakpointId && paused?.hitBreakpoints?.includes(breakpointId));
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(Error("Inspector request failed: " + pending.method));
      else pending.resolve(message.result);
    } else if (message.method === "Debugger.scriptParsed") {
      scripts.set(message.params.scriptId, message.params);
    } else if (message.method === "Debugger.paused") {
      paused = message.params;
      pauseResolve?.(paused);
    } else if (message.method === "Debugger.resumed") paused = undefined;
  });
  socket.addEventListener("close", () => {
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error("Inspector disconnected"));
    }
    requests.clear();
    pauseReject?.(Error("Inspector disconnected before boundary"));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN)
        return reject(Error("Inspector unavailable"));
      const id = ++nextId;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(Error("Inspector timeout: " + method));
      }, 5000);
      requests.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  async function release() {
    clearTimeout(timer);
    pauseResolve = undefined;
    pauseReject = undefined;
    if (socket.readyState === WebSocket.OPEN) {
      if (breakpointId)
        await send("Debugger.removeBreakpoint", { breakpointId }).catch(
          () => {},
        );
      if (ownsPause()) await send("Debugger.resume").catch(() => {});
      await send("Debugger.disable").catch(() => {});
    }
    socket.close();
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Inspector connection timeout")),
        5000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(Error("Inspector connection failed"));
        },
        { once: true },
      );
    });
    // Only identity and an on-disk source digest are evaluated, never app
    // variables, credentials, callbacks or replacement business functions.
    const identity = await send("Runtime.evaluate", {
      expression: `({pid:process.pid,filename:process.getBuiltinModule('node:fs').realpathSync(${JSON.stringify(filename)}),sha256:process.getBuiltinModule('node:crypto').createHash('sha256').update(process.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(filename)})).digest('hex')})`,
      returnByValue: true,
    });
    if (
      identity.exceptionDetails ||
      identity.result?.value?.pid !== pid ||
      identity.result?.value?.sha256 !== sha256
    )
      throw Error("Worker process or source identity mismatch");
    await send("Debugger.enable");
    const canonical = identity.result.value.filename;
    let matches = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      matches = [...scripts.values()].filter(
        (s) => s.url === pathToFileURL(canonical).href || s.url === canonical,
      );
      if (matches.length) break;
      await delay(10);
    }
    if (matches.length !== 1)
      throw Error("Expected one loaded legacy worker script");
    const { scriptId } = matches[0];
    const { scriptSource } = await send("Debugger.getScriptSource", {
      scriptId,
    });
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    let loadedSourceMatches = hash(scriptSource) === sha256;
    if (!loadedSourceMatches) {
      const mapUrl =
        matches[0].sourceMapURL ||
        scriptSource.match(
          /sourceMappingURL=(data:application\/json[^\r\n ]+)/,
        )?.[1];
      const encoded = mapUrl?.match(
        /^data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)$/,
      )?.[1];
      if (encoded && encoded.length < 1000000) {
        const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        loadedSourceMatches =
          map.sourcesContent?.some(
            (value) => typeof value === "string" && hash(value) === sha256,
          ) === true;
      }
    }
    if (!loadedSourceMatches)
      throw Error("Loaded worker source differs from pinned source");
    const loops = [
      ...scriptSource.matchAll(
        /while\s*\(\s*true\s*\)\s*\{\s*const\s+stats\s*=\s*await\s+runOnce\(\s*batchSize\s*\)/g,
      ),
    ];
    if (loops.length !== 1)
      throw Error("Legacy batch boundary differs from reviewed source");
    const index = loops[0].index + loops[0][0].lastIndexOf("runOnce");
    function location(offset) {
      const preceding = scriptSource.slice(0, offset).split("\n");
      return {
        scriptId,
        lineNumber: preceding.length - 1,
        columnNumber: preceding.at(-1).length,
      };
    }
    const start = location(index);
    const end = location(index + "runOnce(batchSize)".length);
    const possible = await send("Debugger.getPossibleBreakpoints", {
      start,
      end,
      restrictToFunction: true,
    });
    const selected = possible.locations.find((l) => l.type === "call");
    if (!selected) throw Error("No executable call boundary before next batch");
    const pendingPause = new Promise((resolve, reject) => {
      pauseResolve = resolve;
      pauseReject = reject;
      timer = setTimeout(
        () => reject(Error("Legacy batch boundary timeout")),
        timeoutMs,
      );
    });
    // Attach the rejection handler now, before awaiting the protocol response.
    pendingPause.catch(() => {});
    const installed = await send("Debugger.setBreakpoint", {
      location: selected,
    });
    breakpointId = installed.breakpointId;
    const event = await pendingPause;
    clearTimeout(timer);
    pauseResolve = undefined;
    pauseReject = undefined;
    const frame = event.callFrames[0];
    if (
      !event.hitBreakpoints?.includes(breakpointId) ||
      frame?.functionName !== "main" ||
      frame.location.scriptId !== scriptId ||
      frame.location.lineNumber !== installed.actualLocation.lineNumber ||
      frame.location.columnNumber !== installed.actualLocation.columnNumber
    )
      throw Error("Paused outside the reviewed batch boundary");
    const expiresAt = Date.now() + holdMs;
    timer = setTimeout(() => {
      void release().catch(() => {});
    }, holdMs);
    return {
      get paused() {
        return ownsPause() && socket.readyState === WebSocket.OPEN;
      },
      expiresAt,
      pid,
      sha256,
      location: installed.actualLocation,
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}
