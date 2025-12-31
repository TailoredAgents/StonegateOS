export const metadata = {
  title: "Privacy Policy | Stonegate Junk Removal",
  description: "How Stonegate Junk Removal collects, uses, and shares personal information."
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default function PrivacyPolicyPage() {
  const lastUpdated = formatDate(new Date());

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:px-10">
      <h1 className="font-display text-4xl text-primary-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-neutral-500">Last updated: {lastUpdated}</p>

      <div className="prose prose-neutral mt-10 max-w-none">
        <p>
          This Privacy Policy explains how Stonegate Junk Removal (&quot;Stonegate&quot;, &quot;we&quot;, &quot;us&quot;)
          collects, uses, and shares information when you visit our website, contact us, or submit a request for service.
        </p>

        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Contact information</strong>: name, phone number, email address.
          </li>
          <li>
            <strong>Service details</strong>: address, requested services, photos you choose to share, and answers you submit on forms.
          </li>
          <li>
            <strong>Message content</strong>: messages you send us via SMS, chat, or social messaging.
          </li>
          <li>
            <strong>Technical data</strong>: IP address, browser/device information, and basic analytics data.
          </li>
        </ul>

        <h2>How we use information</h2>
        <ul>
          <li>To provide quotes, schedule appointments, and deliver services.</li>
          <li>To respond to requests and provide customer support.</li>
          <li>To improve our website, operations, and customer experience.</li>
          <li>To send service updates and important communications.</li>
          <li>To measure marketing performance and improve advertising effectiveness.</li>
        </ul>

        <h2>How we share information</h2>
        <p>
          We may share information with service providers who help us run our business. For example:
        </p>
        <ul>
          <li>
            <strong>Hosting and database</strong> (to operate StonegateOS and store records).
          </li>
          <li>
            <strong>Messaging providers</strong> (to send and receive SMS and notifications).
          </li>
          <li>
            <strong>Advertising and measurement</strong> (to attribute leads and measure campaign performance).
          </li>
        </ul>
        <p>We do not sell your personal information.</p>

        <h2>Data retention</h2>
        <p>
          We keep information for as long as needed to provide services, comply with legal obligations, resolve disputes,
          and enforce agreements.
        </p>

        <h2>Security</h2>
        <p>
          We use reasonable safeguards designed to protect information. No method of transmission or storage is 100% secure.
        </p>

        <h2>Your choices</h2>
        <ul>
          <li>You can request access, correction, or deletion of your information by contacting us.</li>
          <li>You can opt out of marketing messages where applicable (standard message/data rates may apply).</li>
        </ul>

        <h2>Contact</h2>
        <p>
          If you have questions about this policy, contact us at{" "}
          <a href="mailto:austin@stonegatejunkremoval.com">austin@stonegatejunkremoval.com</a>.
        </p>
      </div>
    </div>
  );
}

