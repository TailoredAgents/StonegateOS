import nodemailer from "nodemailer";

export type SendResult = {
  ok: boolean;
  provider?: string;
  providerMessageId?: string | null;
  detail?: string;
};

let cachedTransporter: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter | null {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  const host = process.env["SMTP_HOST"];
  const port = process.env["SMTP_PORT"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];

  if (!host || !port || !user || !pass) {
    return null;
  }

  const parsedPort = Number(port);
  const secure = parsedPort === 465;

  cachedTransporter = nodemailer.createTransport({
    host,
    port: parsedPort,
    secure,
    auth: {
      user,
      pass
    }
  });

  return cachedTransporter;
}

export async function sendSmsMessage(to: string, body: string): Promise<SendResult> {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_FROM"];

  if (!sid || !token || !from) {
    return { ok: false, provider: "twilio", detail: "sms_not_configured" };
  }

  const baseUrl = (process.env["TWILIO_API_BASE_URL"] ?? "https://api.twilio.com").replace(/\/$/, "");

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const form = new URLSearchParams({ From: from, To: to, Body: body }).toString();

    const response = await fetch(`${baseUrl}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`
      },
      body: form
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, provider: "twilio", detail: `sms_failed:${response.status}:${text}` };
    }

    const payload = (await response.json().catch(() => null)) as { sid?: string } | null;
    return {
      ok: true,
      provider: "twilio",
      providerMessageId: payload?.sid ?? null
    };
  } catch (error) {
    return { ok: false, provider: "twilio", detail: `sms_error:${String(error)}` };
  }
}

export async function sendEmailMessage(
  to: string,
  subject: string,
  textBody: string
): Promise<SendResult> {
  const transporter = getTransport();
  const from = process.env["SMTP_FROM"];

  if (!transporter || !from) {
    return { ok: false, provider: "smtp", detail: "email_not_configured" };
  }

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text: textBody
    });

    return {
      ok: true,
      provider: "smtp",
      providerMessageId:
        typeof (info as { messageId?: string }).messageId === "string"
          ? (info as { messageId?: string }).messageId
          : null
    };
  } catch (error) {
    return { ok: false, provider: "smtp", detail: `email_error:${String(error)}` };
  }
}
