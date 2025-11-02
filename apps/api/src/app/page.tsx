export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-900 p-8 text-neutral-100">
      <h1 className="text-3xl font-semibold">Stonegate API Service</h1>
      <p className="max-w-md text-center text-sm text-neutral-300">
        This deployment hosts Stonegate web API endpoints. Visit /api/healthz for a readiness check or use the
        public web site for customer workflows.
      </p>
    </main>
  );
}
