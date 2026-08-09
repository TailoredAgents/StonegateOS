import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");
const SECTION = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/ContactsSection.tsx"),
  "utf8",
);
const WORKSPACE = readFileSync(
  join(ROOT, "apps/site/src/app/team/contacts-workspace.ts"),
  "utf8",
);

describe("Contacts experience contract", () => {
  it("does not convert contact, selection, or directory failures into empty data", () => {
    expect(SECTION).not.toContain('throw new Error("Failed to load contacts")');
    expect(SECTION).toContain("Contacts are temporarily unavailable");
    expect(SECTION).toContain(
      "This is a load failure, not an empty contact list",
    );
    expect(SECTION).toContain("teamMembersUnavailable");
    expect(SECTION).toContain("Selected contact was not opened");
    expect(SECTION).toContain("selectedContactError");
    expect(SECTION).toContain('role="alert"');
    expect(SECTION).toContain("Retry contacts");
  });

  it("keeps list and selected-record state in canonical URLs", () => {
    expect(WORKSPACE).toContain(
      'query.set("contactId", location.contactId.trim())',
    );
    expect(WORKSPACE).toContain('query.set("subview"');
    expect(WORKSPACE).toContain('query.set("q", search)');
    expect(WORKSPACE).toContain('query.set("offset", String(location.offset))');
    expect(WORKSPACE).toContain('query.set("view", location.view)');
    expect(WORKSPACE).toContain('teamSurfaceHref("contacts", { query })');
  });

  it("keeps narrow-screen list/detail navigation and recovery access explicit", () => {
    expect(SECTION).toContain('className="lg:hidden"');
    expect(SECTION).toContain("Back to contacts");
    expect(SECTION).toContain("Recovery access required");
    expect(SECTION).toContain("Return to active contacts");
    expect(SECTION).toContain("ContactRecoveryRestoreForm");
  });
});
