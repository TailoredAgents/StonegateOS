import { readFileSync } from "node:fs";
import { join } from "node:path";

const routeSource = readFileSync(
  join(process.cwd(), "app/api/appointments/[id]/attachments/route.ts"),
  "utf8",
);
const mediaSource = readFileSync(
  join(process.cwd(), "src/lib/appointment-media.ts"),
  "utf8",
);
const appointmentsSource = readFileSync(
  join(process.cwd(), "app/api/appointments/route.ts"),
  "utf8",
);
const mobileSource = readFileSync(
  join(process.cwd(), "../site/src/app/mobile/MobileQuotedWorkPanel.tsx"),
  "utf8",
);
const mobileActionsSource = readFileSync(
  join(process.cwd(), "../site/src/app/mobile/actions.ts"),
  "utf8",
);

describe("retired legacy appointment attachments", () => {
  it("authenticates before returning a truthful permanent retirement response", () => {
    const auth = routeSource.indexOf("requirePermission(");
    const retired = routeSource.indexOf("appointment_attachments_retired");
    expect(auth).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(auth);
    expect(routeSource).toContain("status: 410");
  });

  it("cannot parse, store, or echo caller-controlled attachment data", () => {
    expect(routeSource).not.toContain("request.json(");
    expect(routeSource).not.toContain("request.formData(");
    expect(routeSource).not.toContain("appointmentAttachments");
    expect(routeSource).not.toMatch(/\.insert\(|data:/u);
  });

  it("withholds historical raw URLs until the migration pipeline secures them", () => {
    const legacyProjection = mediaSource.slice(
      mediaSource.indexOf("const legacyAttachments ="),
      mediaSource.indexOf("const summary = summarizeRows"),
    );
    expect(legacyProjection).not.toContain("url: appointmentAttachments.url");
    expect(legacyProjection).toContain(
      ".limit(MAX_VISIBLE_LEGACY_APPOINTMENT_ATTACHMENTS + 1)",
    );
    expect(mediaSource).toContain("rawContentWithheld: true as const");
    expect(mediaSource).toContain("migrationRequired: true as const");
    expect(appointmentsSource).not.toContain("url: appointmentAttachments.url");
    expect(appointmentsSource).toContain("rawContentWithheld: true");
    expect(mobileSource).not.toContain("href={file.url}");
    expect(mobileSource).toContain("Secure migration required before download");
    expect(mobileActionsSource).not.toContain(
      "addMobileAppointmentAttachmentAction",
    );
    expect(mobileActionsSource).not.toContain("data:${contentType};base64");
  });
});
