import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("Team workflow drawer accessibility contract", () => {
  const drawer = source(
    "apps/site/src/app/team/components/TeamWorkflowDrawer.tsx",
  );
  const inbox = source(
    "apps/site/src/app/team/components/InboxCustomerWorkspaceClient.tsx",
  );

  it("uses a named native modal with deterministic focus and scroll behavior", () => {
    expect(drawer).toContain("<dialog");
    expect(drawer).toContain("dialog.showModal()");
    expect(drawer).toContain('aria-modal="true"');
    expect(drawer).toContain("aria-labelledby={titleId}");
    expect(drawer).toContain("aria-describedby={description ? descriptionId");
    expect(drawer).toContain("headingRef.current?.focus()");
    expect(drawer).toContain('document.body.style.overflow = "hidden"');
    expect(drawer).toContain(
      "document.body.style.overflow = previousBodyOverflow",
    );
  });

  it("closes on Escape or the backdrop and restores the invoking control", () => {
    expect(drawer).toContain("onCancel={(event) =>");
    expect(drawer).toContain("event.preventDefault()");
    expect(drawer).toContain("event.target === event.currentTarget");
    expect(drawer).toContain("onCloseRef.current()");
    expect(drawer).toContain("previouslyFocused?.isConnected");
    expect(drawer).toContain("previouslyFocused.focus()");
  });

  it("routes every Inbox customer workflow through the shared drawer", () => {
    expect(inbox).toContain("<TeamWorkflowDrawer");
    expect(inbox).toContain(
      "Complete this customer workflow without losing the current conversation.",
    );
    expect(inbox).not.toContain("function WorkflowDrawer(");
  });
});
