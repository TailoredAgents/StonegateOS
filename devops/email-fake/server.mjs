import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";

const bindHost = process.env["HOST"] === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const httpPort = Number(process.env["HTTP_PORT"] ?? 4016);
const smtpPort = Number(process.env["SMTP_PORT"] ?? 1025);
const forwardHost = process.env["EMAIL_FAKE_FORWARD_SMTP_HOST"]?.trim() || null;
const forwardPort = Number(process.env["EMAIL_FAKE_FORWARD_SMTP_PORT"] ?? 1025);
const MAX_CAPTURED_REQUESTS = 100;
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_SCENARIO_DELAY_MS = 60_000;
const DEFAULT_TIMEOUT_DELAY_MS = 35_000;

const SCENARIOS = new Set([
  "success",
  "temporary_rejection",
  "permanent_rejection",
  "partial_acceptance",
  "data_temporary_error",
  "data_permanent_error",
  "disconnect_after_send",
  "timeout",
  "malformed_response",
]);
const DEFAULT_SCENARIO = Object.freeze({
  name: "success",
  delayMs: 0,
  remaining: null,
});

let scenario = { ...DEFAULT_SCENARIO };
const capturedRequests = [];
const openSockets = new Set();
const openForwardSockets = new Set();
let resetGeneration = 0;

function isApprovedForwardHost(value) {
  return ["mailhog", "localhost", "127.0.0.1", "::1"].includes(
    value?.toLowerCase() ?? "",
  );
}

if (
  (forwardHost && !isApprovedForwardHost(forwardHost)) ||
  (forwardHost && forwardPort !== 1025) ||
  (!forwardHost && process.env["EMAIL_FAKE_FORWARD_SMTP_PORT"]?.trim())
) {
  throw new Error(
    "Email fake relay must use the approved local MailHog target.",
  );
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function resetState() {
  resetGeneration += 1;
  scenario = { ...DEFAULT_SCENARIO };
  capturedRequests.length = 0;
  for (const socket of openSockets) socket.destroy();
  for (const socket of openForwardSockets) socket.destroy();
}

function consumeScenario() {
  const current = { ...scenario };
  if (typeof scenario.remaining === "number") {
    scenario.remaining -= 1;
    if (scenario.remaining <= 0) scenario = { ...DEFAULT_SCENARIO };
  }
  return current;
}

function delay(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function capture(session, input) {
  const headers = input.message.split(/\r?\n\r?\n/u, 1)[0]?.toLowerCase() ?? "";
  capturedRequests.unshift({
    id: randomUUID(),
    operation: "send_email",
    scenario: session.scenario.name,
    receivedAt: new Date().toISOString(),
    bodyBytes: Buffer.byteLength(input.message, "utf8"),
    recipientCount: session.recipients.length,
    acceptedRecipientCount: session.acceptedRecipients.length,
    rejectedRecipientCount: session.rejectedRecipientCount,
    authenticated: session.authenticated,
    subjectHeaderPresent: /^subject\s*:/imu.test(headers),
    messageIdHeaderPresent: /^message-id\s*:/imu.test(headers),
    dispatchHeaderPresent: /^x-stonegate-dispatch\s*:/imu.test(headers),
    attachmentHeaderPresent: /^content-disposition\s*:\s*attachment/imu.test(
      input.message,
    ),
    forwarded: input.forwarded,
    outcome: input.outcome,
  });
  if (capturedRequests.length > MAX_CAPTURED_REQUESTS) {
    capturedRequests.length = MAX_CAPTURED_REQUESTS;
  }
}

function parseSmtpResponse(socket) {
  let buffer = "";
  const lines = [];
  return new Promise((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(() => finish(new Error("smtp_timeout")), 5_000);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index + 1).replace(/\r?\n$/u, "");
        buffer = buffer.slice(index + 1);
        lines.push(line);
        if (/^\d{3} /u.test(line)) {
          const code = Number(line.slice(0, 3));
          finish(null, code);
          return;
        }
      }
    };
    const onError = () => finish(new Error("smtp_transport"));
    const onClose = () => finish(new Error("smtp_closed"));
    const finish = (error, code) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) rejectResponse(error);
      else resolveResponse(code);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function smtpCommand(socket, command, allowed) {
  socket.write(`${command}\r\n`);
  const code = await parseSmtpResponse(socket);
  if (!allowed.includes(code)) throw new Error("smtp_rejected");
}

function dotStuff(message) {
  return message.replace(/\r?\n/gu, "\r\n").replace(/(^|\r\n)\./gu, "$1..");
}

async function forwardMessage(session, message) {
  if (!forwardHost) return true;
  const socket = net.createConnection({ host: forwardHost, port: forwardPort });
  openForwardSockets.add(socket);
  socket.on("close", () => openForwardSockets.delete(socket));
  socket.setNoDelay(true);
  try {
    const greeting = await parseSmtpResponse(socket);
    if (greeting !== 220) throw new Error("smtp_greeting");
    await smtpCommand(socket, "EHLO email-fake", [250]);
    await smtpCommand(socket, `MAIL FROM:${session.sender}`, [250]);
    for (const recipient of session.acceptedRecipients) {
      await smtpCommand(socket, `RCPT TO:${recipient}`, [250, 251]);
    }
    await smtpCommand(socket, "DATA", [354]);
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    const accepted = await parseSmtpResponse(socket);
    if (accepted !== 250) throw new Error("smtp_data_rejected");
    socket.write("QUIT\r\n");
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

function newSession() {
  return {
    authenticated: false,
    authStage: null,
    sender: "<>",
    recipients: [],
    acceptedRecipients: [],
    rejectedRecipientCount: 0,
    scenario: { ...DEFAULT_SCENARIO },
    dataMode: false,
    messageLines: [],
    messageBytes: 0,
    captured: false,
    generation: resetGeneration,
  };
}

function resetEnvelope(session) {
  session.sender = "<>";
  session.recipients = [];
  session.acceptedRecipients = [];
  session.rejectedRecipientCount = 0;
  session.dataMode = false;
  session.messageLines = [];
  session.messageBytes = 0;
  session.captured = false;
}

function captureRejectedEnvelope(session) {
  if (
    session.generation !== resetGeneration ||
    session.captured ||
    session.recipients.length === 0 ||
    session.acceptedRecipients.length > 0
  ) {
    return;
  }
  capture(session, { message: "", forwarded: false, outcome: "rejected" });
  session.captured = true;
}

async function finishMessage(socket, session) {
  const message = session.messageLines.join("\r\n");
  const active = session.scenario;
  const generation = session.generation;
  const waitMs =
    active.name === "timeout" && active.delayMs === 0
      ? DEFAULT_TIMEOUT_DELAY_MS
      : active.delayMs;
  await delay(waitMs);
  if (socket.destroyed || generation !== resetGeneration) return;

  if (active.name === "data_temporary_error") {
    capture(session, { message, forwarded: false, outcome: "rejected" });
    session.captured = true;
    socket.write("451 4.3.0 Temporary provider failure\r\n");
  } else if (active.name === "data_permanent_error") {
    capture(session, { message, forwarded: false, outcome: "rejected" });
    session.captured = true;
    socket.write("554 5.6.0 Permanent provider failure\r\n");
  } else if (active.name === "timeout") {
    capture(session, { message, forwarded: false, outcome: "ambiguous" });
    session.captured = true;
    return;
  } else if (active.name === "malformed_response") {
    capture(session, { message, forwarded: false, outcome: "ambiguous" });
    session.captured = true;
    socket.write("NOT AN SMTP RESPONSE\r\n");
  } else {
    const forwarded = await forwardMessage(session, message);
    if (socket.destroyed || generation !== resetGeneration) return;
    const outcome =
      active.name === "disconnect_after_send" ||
      active.name === "partial_acceptance"
        ? "ambiguous"
        : forwarded
          ? "accepted"
          : "rejected";
    capture(session, { message, forwarded, outcome });
    session.captured = true;
    if (active.name === "disconnect_after_send") {
      socket.destroy();
      return;
    }
    socket.write(
      forwarded
        ? `250 2.0.0 Accepted ${randomUUID()}\r\n`
        : "451 4.3.0 Relay unavailable\r\n",
    );
  }
  resetEnvelope(session);
}

async function processLine(socket, session, line) {
  if (session.dataMode) {
    if (line === ".") {
      session.dataMode = false;
      await finishMessage(socket, session);
      return;
    }
    const unstuffed = line.startsWith("..") ? line.slice(1) : line;
    session.messageBytes += Buffer.byteLength(unstuffed, "utf8") + 2;
    if (session.messageBytes > MAX_MESSAGE_BYTES) {
      session.dataMode = false;
      session.messageLines = [];
      socket.write("552 5.3.4 Message too large\r\n");
      return;
    }
    session.messageLines.push(unstuffed);
    return;
  }

  if (session.authStage === "username") {
    session.authStage = "password";
    socket.write("334 UGFzc3dvcmQ6\r\n");
    return;
  }
  if (session.authStage === "password") {
    session.authStage = null;
    session.authenticated = true;
    socket.write("235 2.7.0 Authentication successful\r\n");
    return;
  }

  const upper = line.toUpperCase();
  if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
    socket.write(
      `250-email-fake\r\n250-SIZE ${MAX_MESSAGE_BYTES}\r\n250-AUTH PLAIN LOGIN\r\n250 PIPELINING\r\n`,
    );
  } else if (upper.startsWith("AUTH PLAIN")) {
    session.authenticated = true;
    socket.write("235 2.7.0 Authentication successful\r\n");
  } else if (upper === "AUTH LOGIN") {
    session.authStage = "username";
    socket.write("334 VXNlcm5hbWU6\r\n");
  } else if (upper.startsWith("MAIL FROM:")) {
    resetEnvelope(session);
    session.sender = line.slice("MAIL FROM:".length).trim();
    session.scenario = consumeScenario();
    session.generation = resetGeneration;
    socket.write("250 2.1.0 Sender accepted\r\n");
  } else if (upper.startsWith("RCPT TO:")) {
    const recipient = line.slice("RCPT TO:".length).trim();
    session.recipients.push(recipient);
    if (session.scenario.name === "temporary_rejection") {
      session.rejectedRecipientCount += 1;
      socket.write("451 4.2.0 Recipient temporarily unavailable\r\n");
    } else if (session.scenario.name === "permanent_rejection") {
      session.rejectedRecipientCount += 1;
      socket.write("550 5.1.1 Recipient rejected\r\n");
    } else if (
      session.scenario.name === "partial_acceptance" &&
      session.acceptedRecipients.length > 0
    ) {
      session.rejectedRecipientCount += 1;
      socket.write("550 5.1.1 Recipient rejected\r\n");
    } else {
      session.acceptedRecipients.push(recipient);
      socket.write("250 2.1.5 Recipient accepted\r\n");
    }
  } else if (upper === "DATA") {
    if (session.acceptedRecipients.length === 0) {
      socket.write("554 5.5.1 No valid recipients\r\n");
    } else {
      session.dataMode = true;
      session.messageLines = [];
      session.messageBytes = 0;
      socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
    }
  } else if (upper === "RSET") {
    captureRejectedEnvelope(session);
    resetEnvelope(session);
    socket.write("250 2.0.0 Reset\r\n");
  } else if (upper === "NOOP") {
    socket.write("250 2.0.0 OK\r\n");
  } else if (upper === "QUIT") {
    captureRejectedEnvelope(session);
    socket.end("221 2.0.0 Bye\r\n");
  } else {
    socket.write("500 5.5.2 Command not recognized\r\n");
  }
}

const smtpServer = net.createServer((socket) => {
  openSockets.add(socket);
  socket.setNoDelay(true);
  socket.on("close", () => {
    captureRejectedEnvelope(session);
    openSockets.delete(socket);
  });
  socket.on("error", () => undefined);
  const session = newSession();
  let buffer = "";
  let queue = Promise.resolve();
  socket.write("220 email-fake ESMTP ready\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES + 64 * 1024) {
      socket.destroy();
      return;
    }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index + 1).replace(/\r?\n$/u, "");
      buffer = buffer.slice(index + 1);
      queue = queue.then(() => processLine(socket, session, line));
    }
  });
});

const controlServer = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://email-fake.invalid");
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      service: "email-fake",
      smtpReady: smtpServer.listening,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__control/reset") {
    resetState();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__control/requests") {
    sendJson(response, 200, {
      requests: capturedRequests,
      retained: capturedRequests.length,
      limit: MAX_CAPTURED_REQUESTS,
    });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/__control/scenario") {
    try {
      const body = JSON.parse(
        (await readBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8"),
      );
      if (
        body?.operation !== "send_email" ||
        !SCENARIOS.has(body?.scenario) ||
        (body?.repeat !== undefined &&
          (!Number.isInteger(body.repeat) ||
            body.repeat < 1 ||
            body.repeat > 100)) ||
        (body?.delayMs !== undefined &&
          (!Number.isInteger(body.delayMs) ||
            body.delayMs < 0 ||
            body.delayMs > MAX_SCENARIO_DELAY_MS))
      ) {
        sendJson(response, 422, { ok: false, error: "invalid_scenario" });
        return;
      }
      scenario = {
        name: body.scenario,
        delayMs: body.delayMs ?? 0,
        remaining: body.repeat ?? null,
      };
      sendJson(response, 200, { ok: true });
    } catch {
      sendJson(response, 400, { ok: false, error: "invalid_request" });
    }
    return;
  }
  sendJson(response, 404, { ok: false, error: "not_found" });
});

smtpServer.listen(smtpPort, bindHost);
controlServer.listen(httpPort, bindHost);

function shutdown() {
  for (const socket of openSockets) socket.destroy();
  for (const socket of openForwardSockets) socket.destroy();
  smtpServer.close();
  controlServer.close();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
