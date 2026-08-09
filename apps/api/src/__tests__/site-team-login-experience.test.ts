import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE_ROOT = join(process.cwd(), "../site/src");

function site(relativePath: string): string {
  return readFileSync(join(SITE_ROOT, relativePath), "utf8");
}

describe("Team login experience", () => {
  const page = site("app/team/login/page.tsx");
  const submitButton = site("app/team/login/LoginSubmitButton.tsx");

  it("keeps magic-link delivery non-enumerating and errors recoverable", () => {
    expect(page).toContain("If your email is on the team");
    expect(page).toContain('role="status"');
    expect(page).toContain('role="alert"');
    expect(page).toContain("expired or has already been used");
    expect(page).toContain("Request a new link");
    expect(page).toContain("temporarily unavailable");
  });

  it("prevents duplicate login submissions and announces pending work", () => {
    expect(page).toContain("LoginSubmitButton");
    expect(page).toContain('pendingLabel="Sending secure link…"');
    expect(page).toContain('pendingLabel="Signing in…"');
    expect(submitButton).toContain("useFormStatus");
    expect(submitButton).toContain("disabled={pending}");
    expect(submitButton).toContain("aria-busy={pending}");
    expect(submitButton).toContain('aria-live="polite"');
    expect(submitButton).toContain("min-h-11");
  });

  it("uses persistent labels and password-manager-compatible fields", () => {
    expect(page).toContain('autoComplete="username"');
    expect(page).toContain('autoComplete="current-password"');
    expect(page).toContain('type="password"');
    expect(page).toContain("Email or phone");
    expect(page).toContain("Password");
  });
});
