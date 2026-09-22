import { CookieSettingsButton } from "@/components/CookieSettingsButton";

export const metadata = {
  title: "Privacy Policy | Stonegate Junk Removal",
  description:
    "How Stonegate Junk Removal collects, uses, and shares personal information.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:px-10">
      <h1 className="font-display text-4xl text-primary-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Last updated: September 15, 2026
      </p>

      <div className="prose prose-neutral mt-10 max-w-none">
        <p>
          This Privacy Policy explains how Stonegate Junk Removal
          (&quot;Stonegate&quot;, &quot;we&quot;, &quot;us&quot;) collects,
          uses, and shares information when you visit our website, contact us,
          or submit a request for service.
        </p>

        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Contact information</strong>: name, phone number, email
            address.
          </li>
          <li>
            <strong>Service details</strong>: address, requested services,
            photos you choose to share, and answers you submit on forms.
          </li>
          <li>
            <strong>Message content</strong>: messages you send us via SMS,
            chat, or social messaging.
          </li>
          <li>
            <strong>Technical data</strong>: IP address, browser/device
            information, and basic analytics data.
          </li>
        </ul>

        <h2>How we use information</h2>
        <ul>
          <li>
            To provide quotes, schedule appointments, and deliver services.
          </li>
          <li>To respond to requests and provide customer support.</li>
          <li>To improve our website, operations, and customer experience.</li>
          <li>To send service updates and important communications.</li>
          <li>
            To measure marketing performance and improve advertising
            effectiveness.
          </li>
        </ul>

        <h2>How we share information</h2>
        <p>
          We may share information with service providers who help us run our
          business. For example:
        </p>
        <ul>
          <li>
            <strong>Hosting and database</strong> (to operate StonegateOS and
            store records).
          </li>
          <li>
            <strong>Messaging providers</strong> (to send and receive SMS and
            notifications).
          </li>
          <li>
            <strong>Advertising and measurement</strong> (to attribute leads and
            measure campaign performance).
          </li>
        </ul>
        <p>
          We do not sell personal information for money. When you allow
          advertising, we share measurement information with advertising
          providers as described below. Some privacy laws define certain
          advertising disclosures as a &quot;sale&quot; or &quot;sharing&quot;
          even when no money is exchanged.
        </p>

        <h2 id="cookies" className="scroll-mt-24">
          Cookies and similar technologies
        </h2>
        <p>
          Cookies are small files stored in your browser. We also use local
          storage and session storage, which keep information in your browser
          without sending it with every website request. Necessary technologies
          support features such as security, sign-in, and remembering your
          privacy choice. Optional analytics help us understand website visits
          and performance. Optional advertising technologies connect ad visits
          with inquiries and bookings and help providers measure and personalize
          advertising.
        </p>
        <p>
          On our public website, optional analytics and advertising stay off
          until you allow them. You can accept optional cookies, reject them, or
          choose analytics and advertising separately. Closing the notice
          without making a choice leaves optional tracking off. You can use our
          website and request service without accepting optional cookies.
        </p>
        <p>
          The table below describes the main cookies and browser storage used by
          our public website. Lifetimes may restart when a cookie is renewed and
          may be shortened by your browser settings. Advertising providers can
          change the cookies they use; see their policies linked below for
          details.
        </p>
        <div
          className="overflow-x-auto rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-700"
          role="region"
          aria-label="Cookie and browser storage details"
          tabIndex={0}
        >
          <table className="min-w-[36rem] text-sm">
            <caption className="sr-only">
              Cookies and browser storage on our public website
            </caption>
            <thead>
              <tr>
                <th scope="col">Provider / storage</th>
                <th scope="col">Category and purpose</th>
                <th scope="col">Lifetime</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  Stonegate: <code>sg_cookie_consent</code>
                </th>
                <td>
                  Necessary cookie that remembers your analytics and advertising
                  choices.
                </td>
                <td>180 days after saving your choice.</td>
              </tr>
              <tr>
                <th scope="row">
                  Google Ads: <code>_gcl_au</code>
                </th>
                <td>
                  Advertising cookie used to measure ad and conversion
                  performance.
                </td>
                <td>90 days.</td>
              </tr>
              <tr>
                <th scope="row">
                  Meta Pixel: <code>_fbp</code>
                </th>
                <td>
                  Advertising cookie that identifies a browser for ad
                  measurement.
                </td>
                <td>90 days.</td>
              </tr>
              <tr>
                <th scope="row">
                  OpenAI: <code>__obref</code>
                </th>
                <td>
                  Advertising cookie that identifies a browser for ChatGPT ad
                  measurement.
                </td>
                <td>365 days.</td>
              </tr>
              <tr>
                <th scope="row">
                  OpenAI / Stonegate: <code>__oppref</code>
                </th>
                <td>
                  Advertising cookie that retains a ChatGPT ad-click identifier.
                </td>
                <td>Up to 30 days.</td>
              </tr>
              <tr>
                <th scope="row">
                  Stonegate: <code>myst_utm</code>
                </th>
                <td>
                  Advertising cookie that remembers campaign details for lead
                  attribution.
                </td>
                <td>30 days.</td>
              </tr>
              <tr>
                <th scope="row">
                  Stonegate: <code>sg:session</code> in local storage
                </th>
                <td>
                  Analytics identifier used to understand returning website
                  visits.
                </td>
                <td>
                  Replaced on a later visit after 30 days; local storage has no
                  automatic expiry.
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Stonegate: <code>sg:visit</code>, <code>sg:visit_last</code>,{" "}
                  <code>sg:visit_started</code>, and <code>sg:utm</code> in
                  session storage
                </th>
                <td>
                  Analytics visit state and, when advertising is allowed,
                  campaign context.
                </td>
                <td>
                  Usually cleared when the tab closes. Visits restart after 30
                  minutes of inactivity; browser session restoration may
                  preserve storage.
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Stonegate: <code>sg:openai-ads-attribution</code> in local
                  storage
                </th>
                <td>
                  Advertising data linking a ChatGPT ad visit to a later service
                  request.
                </td>
                <td>
                  Used for attribution for up to 30 days. Local storage can
                  remain until removed by the site or cleared in your browser.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          We may also store privacy preferences and information needed to honor
          opt-out requests in browser storage. These records support your
          choices. Third-party services you use, such as sign-in, payment, or
          embedded services, may use their own necessary security cookies and
          are covered by their providers&apos; policies.
        </p>
        <p>
          Advertising providers may receive information about your browser,
          device, IP address, page visits, ad interactions, and conversions when
          advertising is allowed. Their use of this information is explained in{" "}
          <a href="https://policies.google.com/privacy">
            Google&apos;s Privacy Policy
          </a>
          ,{" "}
          <a href="https://www.facebook.com/privacy/policy/">
            Meta&apos;s Privacy Policy
          </a>
          , and{" "}
          <a href="https://openai.com/policies/privacy-policy/">
            OpenAI&apos;s Privacy Policy
          </a>
          .
        </p>
        <p>
          Our own website analytics, and Google Analytics where used, help us
          understand visits, performance, and completed service requests. They
          follow your Analytics choice. If you allow Advertising, Google
          enhanced conversion measurement may also use contact details you
          submit, such as your email, phone number, name, and address, to match
          an inquiry or booking to an ad, including through hashed identifiers.
        </p>

        <h3>Managing your cookie choices</h3>
        <p>
          Use Cookie settings here or in the website footer to change or
          withdraw your permission for this browser. We remember your choice for
          180 days, unless you clear it sooner. Global Privacy Control and Do
          Not Track signals turn off optional analytics and advertising,
          including Google, Meta, and OpenAI, while the signal is enabled.
          Necessary features remain available.
        </p>
        <div className="not-prose my-5">
          <CookieSettingsButton className="inline-flex min-h-11 items-center rounded-lg border border-primary-800 px-4 py-2 text-sm font-semibold text-primary-900 hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700" />
        </div>
        <p>
          Changes apply to future tracking from this browser and do not undo
          information already processed. We remove optional first-party cookies
          and browser storage where accessible when you turn the relevant
          category off. You can also delete cookies and browser storage using
          your browser settings; we cannot directly remove cookies stored on
          other providers&apos; domains. Choices apply separately to each
          browser and device. Contact us about information already held in our
          records or by an advertising provider.
        </p>

        <h2>ChatGPT advertising measurement</h2>
        <p>
          When you allow advertising, we use OpenAI&apos;s ChatGPT advertising
          measurement to understand which ads lead to visits, confirmed
          bookings, and phone inquiries. On public website pages, this can use
          an ad-click identifier and a browser identifier stored in first-party
          cookies. We may connect these identifiers to your service request and
          report a confirmed booking or qualifying phone inquiry from our
          server. Matching may also use one-way hashed versions of your phone
          number or email address. A click on a phone link is measured
          separately from an actual inquiry. We do not include your service
          notes, photos, or private quote links in these events.
        </p>
        <p>
          ChatGPT ad measurement follows the shared advertising choice in Cookie
          settings and honors this browser&apos;s Do Not Track and Global
          Privacy Control signals. Website attribution is used for up to 30
          days; the separate OpenAI browser identifier cookie can last up to one
          year. Turning advertising off also applies to future ChatGPT
          measurement for linked service requests. Service records follow the
          retention policy below.
        </p>

        <h2>Data retention</h2>
        <p>
          We keep information for as long as needed to provide services, comply
          with legal obligations, resolve disputes, and enforce agreements.
        </p>

        <h2>Security</h2>
        <p>
          We use reasonable safeguards designed to protect information. No
          method of transmission or storage is 100% secure.
        </p>

        <h2>Your choices</h2>
        <ul>
          <li>
            You can request access, correction, or deletion of your information
            by contacting us.
          </li>
          <li>
            You can opt out of marketing messages where applicable (standard
            message/data rates may apply).
          </li>
        </ul>

        <h2>Contact</h2>
        <p>
          If you have questions about this policy, contact us at{" "}
          <a href="mailto:sales@stonegatejunkremoval.com">
            sales@stonegatejunkremoval.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
