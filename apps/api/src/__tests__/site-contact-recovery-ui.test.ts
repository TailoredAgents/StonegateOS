import fs from "node:fs";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("Team contact recovery UI contract", () => {
  const apiListRoute = source("apps/api/app/api/admin/contacts/route.ts");
  const actions = source("apps/site/src/app/team/actions.ts");
  const contactsSection = source(
    "apps/site/src/app/team/components/ContactsSection.tsx",
  );
  const restoreForm = source(
    "apps/site/src/app/team/components/ContactRecoveryRestoreForm.tsx",
  );
  const detailsPane = source(
    "apps/site/src/app/team/components/ContactsDetailsPaneClient.tsx",
  );
  const contactsList = source(
    "apps/site/src/app/team/components/ContactsListClient.tsx",
  );

  it("exposes deleted contacts only through the separately authorized recovery query", () => {
    expect(apiListRoute).toContain(
      'const deletedOnly = searchParams.get("deleted") === "only"',
    );
    expect(apiListRoute).toContain('"contacts.restore"');
    expect(apiListRoute).toContain(
      "deletedOnly ? isNotNull(contacts.deletedAt) : isNull(contacts.deletedAt)",
    );
    expect(apiListRoute).toContain(
      "deletedAt: contact.deletedAt?.toISOString() ?? null",
    );
    expect(apiListRoute).toContain(
      "recoverableUntil: contact.purgeEligibleAt?.toISOString() ?? null",
    );
  });

  it("shows a truthful permission boundary and a searchable recovery list", () => {
    expect(contactsSection).toContain(
      'hasTeamPermission(principal, "contacts.restore")',
    );
    expect(contactsSection).toContain("Recovery access required");
    expect(contactsSection).toContain('params.set("deleted", "only")');
    expect(contactsSection).toContain("Contact recovery");
    expect(contactsSection).toContain(
      "Restoring a contact does not restart automation or release",
    );
    expect(contactsSection).toContain("ContactRecoveryRestoreForm");
    expect(contactsSection).not.toContain("This cannot be undone");
  });

  it("requires confirmation and explains the post-restore safety hold", () => {
    expect(restoreForm).toContain("window.confirm(");
    expect(restoreForm).toContain(
      "Automation and quarantined operations will remain paused",
    );
    expect(restoreForm).toContain('pendingLabel="Restoring..."');
    expect(restoreForm).toContain("Restore contact");
    expect(restoreForm).toContain('name="expectedVersion"');
    expect(restoreForm).toContain('name="idempotencyKey"');
    expect(restoreForm).toContain("contact-restore:${contactId}:${expectedVersion}");
  });

  it("checks the restore response before displaying a success message", () => {
    const start = actions.indexOf("export async function restoreContactAction");
    const end = actions.indexOf(
      "export async function addPropertyAction",
      start,
    );
    const action = actions.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(action).toContain("/restore`");
    expect(action).toContain('method: "POST"');
    expect(action).toContain("resolveTeamMutationFeedback(");
    expect(action).toContain('"Idempotency-Key": idempotencyKey.trim()');
    expect(action).toContain('"If-Match": expectedVersion.trim()');
    expect(action).toContain("await setMutationFlash(feedback)");
    expect(action).toContain(
      "Automation and queued operations remain paused until an owner reviews them.",
    );
  });

  it("describes deletion as recoverable in both contact workspaces", () => {
    for (const component of [detailsPane, contactsList]) {
      expect(component).toContain("Move to recovery");
      expect(component).toContain("hidden from active CRM views for 30 days");
      expect(component).toContain("queued operations will be quarantined");
      expect(component).not.toContain("This cannot be undone");
      expect(component).toContain('name="expectedVersion"');
      expect(component).toContain('name="idempotencyKey"');
      expect(component).toContain("contact-delete:");
    }

    const deleteStart = actions.indexOf(
      "export async function deleteContactAction",
    );
    const deleteEnd = actions.indexOf(
      "export async function restoreContactAction",
      deleteStart,
    );
    const deleteAction = actions.slice(deleteStart, deleteEnd);
    expect(deleteAction).toContain("resolveTeamMutationFeedback(");
    expect(deleteAction).toContain(
      '"Idempotency-Key": idempotencyKey.trim()',
    );
    expect(deleteAction).toContain('"If-Match": expectedVersion.trim()');
    expect(deleteAction).toContain("Contact moved to 30-day recovery");
    expect(deleteAction).not.toContain('value: "Contact deleted"');
  });
});
