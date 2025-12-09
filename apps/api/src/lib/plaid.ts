import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

function getEnvVars():
  | {
      clientId: string;
      secret: string;
      env: keyof typeof PlaidEnvironments;
    }
  | null {
  const clientId = process.env["PLAID_CLIENT_ID"];
  const secret = process.env["PLAID_SECRET"];
  const env = (process.env["PLAID_ENV"] ?? "sandbox").toLowerCase() as keyof typeof PlaidEnvironments;
  if (!clientId || !secret || !PlaidEnvironments[env]) {
    return null;
  }
  return { clientId, secret, env };
}

export function getPlaidClient(): PlaidApi | null {
  const cfg = getEnvVars();
  if (!cfg) return null;
  const config = new Configuration({
    basePath: PlaidEnvironments[cfg.env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": cfg.clientId,
        "PLAID-SECRET": cfg.secret
      }
    }
  });
  return new PlaidApi(config);
}

export function plaidConfigured(): boolean {
  return Boolean(getEnvVars());
}
