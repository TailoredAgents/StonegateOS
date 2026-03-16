import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamRole } from "@/app/api/team/auth";
import {
  buildStoredContactSource,
  parseLeadSourceFormData,
} from "@/app/team/lib/booking-details";

export const dynamic = "force-dynamic";

function buildContactsRedirect(
  request: NextRequest,
  contactId?: string | null,
): URL {
  const url = getSafeRedirectUrl(request, "/team?tab=contacts");
  url.searchParams.set("tab", "contacts");
  if (contactId) url.searchParams.set("created", contactId);
  return url;
}

export async function POST(request: NextRequest): Promise<Response> {
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=contacts");
  const auth = await requireTeamRole(request, {
    redirectTo,
    roles: ["owner", "office", "crew"],
  });

  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const firstName = formData.get("firstName");
  const lastName = formData.get("lastName");
  const email = formData.get("email");
  const phone = formData.get("phone");
  const pipelineStage = formData.get("pipelineStage");
  const pipelineNotes = formData.get("pipelineNotes");
  const salespersonMemberId = formData.get("salespersonMemberId");
  const addressLine1 = formData.get("addressLine1");
  const city = formData.get("city");
  const state = formData.get("state");
  const postalCode = formData.get("postalCode");

  if (
    typeof firstName !== "string" ||
    typeof lastName !== "string" ||
    firstName.trim().length === 0 ||
    lastName.trim().length === 0
  ) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "First and last name are required",
      path: "/",
    });
    return response;
  }

  const sourceResult = parseLeadSourceFormData(formData);
  if (!sourceResult.ok) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: sourceResult.error,
      path: "/",
    });
    return response;
  }

  const payload: Record<string, unknown> = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email:
      typeof email === "string" && email.trim().length
        ? email.trim()
        : undefined,
    phone:
      typeof phone === "string" && phone.trim().length
        ? phone.trim()
        : undefined,
    source: buildStoredContactSource(sourceResult.value),
    pipelineStage:
      typeof pipelineStage === "string" && pipelineStage.trim().length
        ? pipelineStage.trim()
        : undefined,
    pipelineNotes:
      typeof pipelineNotes === "string" && pipelineNotes.trim().length
        ? pipelineNotes.trim()
        : undefined,
  };

  if (typeof salespersonMemberId === "string") {
    const trimmed = salespersonMemberId.trim();
    payload["salespersonMemberId"] = trimmed.length > 0 ? trimmed : null;
  }

  const hasAddress =
    typeof addressLine1 === "string" &&
    typeof city === "string" &&
    typeof state === "string" &&
    typeof postalCode === "string" &&
    addressLine1.trim().length > 0 &&
    city.trim().length > 0 &&
    state.trim().length > 0 &&
    postalCode.trim().length > 0;

  const anyAddressField =
    (typeof addressLine1 === "string" && addressLine1.trim().length > 0) ||
    (typeof city === "string" && city.trim().length > 0) ||
    (typeof state === "string" && state.trim().length > 0) ||
    (typeof postalCode === "string" && postalCode.trim().length > 0);

  if (anyAddressField && !hasAddress) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value:
        "If you add an address, include street, city, state, and postal code",
      path: "/",
    });
    return response;
  }

  if (hasAddress) {
    payload["property"] = {
      addressLine1: (addressLine1 as string).trim(),
      city: (city as string).trim(),
      state: (state as string).trim(),
      postalCode: (postalCode as string).trim(),
    };
  }

  const apiResponse = await callAdminApi("/api/admin/contacts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!apiResponse.ok) {
    let message = "Unable to create contact";
    try {
      const data = (await apiResponse.json()) as {
        error?: string;
        existingContact?: {
          id?: string;
          firstName?: string | null;
          lastName?: string | null;
        } | null;
      };
      if (data.error === "contact_already_exists") {
        const existingName =
          `${data.existingContact?.firstName ?? ""} ${data.existingContact?.lastName ?? ""}`.trim();
        message =
          existingName.length > 0
            ? `Contact already exists (${existingName}).`
            : "Contact already exists.";
        const existingId =
          typeof data.existingContact?.id === "string"
            ? data.existingContact.id
            : null;
        const response = NextResponse.redirect(
          buildContactsRedirect(request, existingId),
          303,
        );
        response.cookies.set({
          name: "myst-flash-error",
          value: message,
          path: "/",
        });
        return response;
      } else if (data.error) {
        message = data.error.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: message,
      path: "/",
    });
    return response;
  }

  let createdId: string | null = null;
  try {
    const data = (await apiResponse.json()) as { contact?: { id?: string } };
    if (
      typeof data?.contact?.id === "string" &&
      data.contact.id.trim().length > 0
    ) {
      createdId = data.contact.id.trim();
    }
  } catch {
    createdId = null;
  }

  const response = NextResponse.redirect(
    buildContactsRedirect(request, createdId),
    303,
  );
  response.cookies.set({
    name: "myst-flash",
    value: "Contact created",
    path: "/",
  });
  return response;
}
