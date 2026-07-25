import {
  areAppointmentMediaWritesEnabled,
  arePublicQuoteMediaUploadsEnabled,
  isMediaAutoImportEnabled,
  isMobileOfflineMediaEnabled,
} from "@/lib/feature-flags";

describe("media operational feature flags", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  const originalValues = {
    writes: process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"],
    publicUploads: process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"],
    imports: process.env["MEDIA_AUTO_IMPORT_ENABLED"],
    offline: process.env["MOBILE_OFFLINE_MEDIA_ENABLED"],
  };

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: originalNodeEnv,
      writable: true,
    });
    if (originalValues.writes === undefined) {
      delete process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"];
    } else {
      process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"] = originalValues.writes;
    }
    if (originalValues.publicUploads === undefined) {
      delete process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"];
    } else {
      process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"] =
        originalValues.publicUploads;
    }
    if (originalValues.imports === undefined) {
      delete process.env["MEDIA_AUTO_IMPORT_ENABLED"];
    } else {
      process.env["MEDIA_AUTO_IMPORT_ENABLED"] = originalValues.imports;
    }
    if (originalValues.offline === undefined) {
      delete process.env["MOBILE_OFFLINE_MEDIA_ENABLED"];
    } else {
      process.env["MOBILE_OFFLINE_MEDIA_ENABLED"] = originalValues.offline;
    }
  });

  it("defaults risky operations off in production", () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "production",
      writable: true,
    });
    delete process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"];
    delete process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"];
    delete process.env["MEDIA_AUTO_IMPORT_ENABLED"];
    delete process.env["MOBILE_OFFLINE_MEDIA_ENABLED"];

    expect(areAppointmentMediaWritesEnabled()).toBe(false);
    expect(arePublicQuoteMediaUploadsEnabled()).toBe(false);
    expect(isMediaAutoImportEnabled()).toBe(false);
    expect(isMobileOfflineMediaEnabled()).toBe(false);
  });

  it("honors explicit production enables and development disables", () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "production",
      writable: true,
    });
    process.env["APPOINTMENT_MEDIA_WRITES_ENABLED"] = "true";
    expect(areAppointmentMediaWritesEnabled()).toBe(true);
    expect(arePublicQuoteMediaUploadsEnabled()).toBe(false);

    process.env["PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED"] = "true";
    expect(arePublicQuoteMediaUploadsEnabled()).toBe(true);

    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "development",
      writable: true,
    });
    process.env["MEDIA_AUTO_IMPORT_ENABLED"] = "0";
    expect(isMediaAutoImportEnabled()).toBe(false);
  });
});
