import { AdminLoginForm } from "./LoginForm";

export const metadata = {
  title: "Stonegate Admin Sign In"
};

export default async function AdminLoginPage({
  searchParams
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const params = await searchParams;
  const redirectTo = params?.redirectTo ?? "/admin/quotes";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-16">
      <div className="space-y-2 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">Stonegate Ops</p>
        <h1 className="text-2xl font-semibold text-primary-900">Admin access</h1>
        <p className="text-sm text-neutral-600">Enter the admin key from 1Password to view estimates, quotes, and payments.</p>
      </div>
      <AdminLoginForm redirectTo={redirectTo} />
    </main>
  );
}
