import { CrewLoginForm } from "./LoginForm";

export const metadata = {
  title: "Stonegate Crew Sign In"
};

export default async function CrewLoginPage({
  searchParams
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const params = await searchParams;
  const redirectTo = params?.redirectTo ?? "/crew";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-16">
      <div className="space-y-2 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">Stonegate Crew</p>
        <h1 className="text-2xl font-semibold text-primary-900">Crew access</h1>
        <p className="text-sm text-neutral-600">Enter the crew key to view today\'s visits.</p>
      </div>
      <CrewLoginForm redirectTo={redirectTo} />
    </main>
  );
}

