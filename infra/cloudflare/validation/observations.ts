// Fixed, read-only destinations: never accept a caller-provided URL or credentials.
export const observationEndsAt = '2026-11-22T22:00:00.000Z';
const targets = [
  {name:'website-home',url:'https://stonegatejunkremoval.com/',statuses:[200]},
  {name:'website-book',url:'https://stonegatejunkremoval.com/book',statuses:[200]},
  {name:'partner-login',url:'https://stonegatejunkremoval.com/partners/login',statuses:[200]},
  {name:'api-health',url:'https://stonegate-api.onrender.com/api/healthz',statuses:[200]},
  {name:'api-readiness',url:'https://stonegate-api.onrender.com/api/readyz',statuses:[200]},
  {name:'admin-unauthenticated',url:'https://stonegate-api.onrender.com/api/admin/contacts',statuses:[401,403]},
];

export async function observe(bucket: R2Bucket, scheduledAt: number | undefined, siteGateway: Fetcher) {
  const now = Date.now();
  if (now >= Date.parse(observationEndsAt)) return {expired:true,endsAt:observationEndsAt};
  const checks = await Promise.all(targets.map(async target => {
    const started = Date.now();
    try {
      const cloudflareSite = new URL(target.url).hostname === "stonegatejunkremoval.com";
      const request = new Request(target.url, {
        method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000),
        headers:{'user-agent':'StonegateMigrationHealth/1.0','cache-control':'no-cache'},
      });
      // Same-zone fetch can bypass Worker routes. The service binding exercises
      // the actual production controller; external browser tests cover routing.
      const response = cloudflareSite ? await siteGateway.fetch(request) : await fetch(request);
      // Discard bodies: readiness details, cookies and customer data are never retained.
      await response.body?.cancel();
      return {name:target.name,status:response.status,
        transport:cloudflareSite?'site-service-binding':'public-http',
        hosting:response.headers.get('x-stonegate-hosting'),
        pass:target.statuses.includes(response.status) && (!cloudflareSite || response.headers.get('x-stonegate-hosting')==='cloudflare'),ms:Date.now()-started};
    } catch {
      return {name:target.name,status:null,pass:false,ms:Date.now()-started};
    }
  }));
  const receipt = {at:new Date(now).toISOString(),scheduledAt:scheduledAt??null,
    endsAt:observationEndsAt,pass:checks.every(check=>check.pass),checks};
  const body = JSON.stringify(receipt);
  // Separate keys preserve every run even if two invocations overlap. Consumers sort
  // by receipt.at rather than relying on a racy mutable "latest" object.
  await bucket.put(`observations/${receipt.at}/${crypto.randomUUID()}.json`,body,
    {httpMetadata:{contentType:'application/json'}});
  console.log(JSON.stringify({event:'migration_health_observation',pass:receipt.pass,
    failures:checks.filter(check=>!check.pass).map(check=>check.name)}));
  return receipt;
}

export async function observationHistory(bucket:R2Bucket) {
  // This fixed seven-day run produces at most 672 scheduled records. Bound manual
  // reads too; truncation is explicitly reported if manual runs exceed the bound.
  const listing = await bucket.list({prefix:'observations/',limit:1000});
  return {endsAt:observationEndsAt,expired:Date.now()>=Date.parse(observationEndsAt),
    objects:listing.objects.map(object=>({key:object.key,uploaded:object.uploaded,size:object.size})),
    truncated:listing.truncated};
}
