export const metadata = {
  title: "Terms of Service | Stonegate Junk Removal",
  description: "Terms and conditions for using Stonegate Junk Removal's website and services."
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default function TermsPage() {
  const lastUpdated = formatDate(new Date());

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:px-10">
      <h1 className="font-display text-4xl text-primary-900">Terms of Service</h1>
      <p className="mt-2 text-sm text-neutral-500">Last updated: {lastUpdated}</p>

      <div className="prose prose-neutral mt-10 max-w-none">
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your use of our website and any requests you submit for quotes,
          scheduling, or service. By using our website, you agree to these Terms.
        </p>

        <h2>Quotes and scheduling</h2>
        <p>
          Quotes and schedules may change based on on-site conditions, access, volume, and material type. Final pricing
          is confirmed by our team.
        </p>

        <h2>Communications</h2>
        <p>
          If you provide a phone number or email, you authorize us to contact you about your request, including by SMS or
          email. Message/data rates may apply.
        </p>

        <h2>Acceptable use</h2>
        <p>You agree not to misuse the website or attempt to disrupt or access systems without authorization.</p>

        <h2>Disclaimer</h2>
        <p>
          The website is provided &quot;as is&quot; without warranties of any kind to the maximum extent permitted by law.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, Stonegate will not be liable for indirect, incidental, special, or
          consequential damages arising from your use of the website.
        </p>

        <h2>Changes</h2>
        <p>We may update these Terms from time to time by posting an updated version on this page.</p>

        <h2>Contact</h2>
        <p>
          Questions about these Terms? Email{" "}
          <a href="mailto:austin@stonegatejunkremoval.com">austin@stonegatejunkremoval.com</a>.
        </p>
      </div>
    </div>
  );
}

