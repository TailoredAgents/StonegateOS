import { redirect } from "next/navigation";
import {
  hasTeamPermission,
  resolveTeamPrincipalFromCookies,
} from "@/lib/team-principal";
import { quoteWorkspaceHref } from "../../quotes-workspace";

export const metadata = {
  title: "Instant Quote | Stonegate Team Console",
  robots: { index: false, follow: false },
};

export default async function InstantQuotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await resolveTeamPrincipalFromCookies();
  if (!principal) {
    redirect("/team/login");
  }
  if (!hasTeamPermission(principal, "quotes.read")) {
    redirect("/team");
  }

  const { id } = await params;
  redirect(
    quoteWorkspaceHref("instant", {
      query: { instantQuoteId: id },
    }),
  );
}
