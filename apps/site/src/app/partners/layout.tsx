import Link from "next/link";

export const metadata = {
  title: "Stonegate Partner Portal",
  robots: { index: false, follow: false }
};

export default function PartnersLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-white">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/partners" className="text-sm font-semibold text-slate-900">
            Stonegate Partner Portal
          </Link>
          <nav className="flex flex-wrap items-center gap-2 text-xs">
            <Link href="/partners/book" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-700 hover:border-primary-300 hover:text-primary-700">
              Book
            </Link>
            <Link href="/partners/bookings" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-700 hover:border-primary-300 hover:text-primary-700">
              Bookings
            </Link>
            <Link href="/partners/properties" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-700 hover:border-primary-300 hover:text-primary-700">
              Properties
            </Link>
            <Link href="/partners/settings" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-700 hover:border-primary-300 hover:text-primary-700">
              Settings
            </Link>
            <form action="/partners/logout" method="post">
              <button type="submit" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-700 hover:border-rose-300 hover:text-rose-700">
                Log out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
