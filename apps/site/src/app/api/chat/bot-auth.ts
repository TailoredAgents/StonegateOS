import type { NextRequest } from "next/server";
import crypto from "node:crypto";

const BOT_HEADER_NAME = "x-stonegate-bot-key";

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function isAgentBotRequest(request: NextRequest): boolean {
  const secret = process.env["AGENT_BOT_SHARED_SECRET"];
  if (!secret) return false;
  const provided = request.headers.get(BOT_HEADER_NAME) ?? "";
  return timingSafeEqual(provided, secret);
}

