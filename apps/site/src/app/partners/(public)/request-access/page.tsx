import type { Metadata } from "next";
import Link from "next/link";
import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";

export const metadata: Metadata = {
  title: "Partner access and help",
  robots: { index: false, follow: false, nocache: true },
};

export default function PartnerRequestAccessPage() {
  return (
    <section className="mx-auto max-w-xl">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
        Partner access and help
      </h1>
      <p className="mt-4 text-base leading-7 text-slate-600">
        The portal is for people Stonegate already works with. Contact us to get
        set up, replace an invitation, or get help with your account.
      </p>
      <PartnerAccessHelp className="mt-6" />
      <Link
        href="/partners/login"
        className="mt-6 inline-flex min-h-11 items-center font-semibold text-primary-900 underline underline-offset-4"
      >
        Already set up? Sign in
      </Link>
    </section>
  );
}
