import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Next.js embeds public variables and CSP configuration at build time.
// Accept only those fields; server credentials must never enter image layers.
const values=JSON.parse(readFileSync('/run/secrets/site_build_env','utf8'));
if(!values || Array.isArray(values) || typeof values!=='object')throw new Error('Missing public site build configuration');
for(const [key,value] of Object.entries(values)) {
  if((!key.startsWith('NEXT_PUBLIC_') && key!=='PARTNER_MEDIA_STORAGE_ORIGIN') || typeof value!=='string') {
    throw new Error('Unexpected field in public site build configuration');
  }
}
if(!values.NEXT_PUBLIC_SITE_URL || !values.NEXT_PUBLIC_API_BASE_URL)throw new Error('Site and API origins are required');
const env={...process.env,...values};
for(const args of [['--filter','site','exec','contentlayer','build'],['--filter','site','build']]) {
  const result=spawnSync('pnpm',args,{env,stdio:'inherit'});
  if(result.error || result.status!==0)process.exit(result.status||1);
}
const canonical=JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a],[b])=>a.localeCompare(b))));
writeFileSync('/app/infra/cloudflare/site-public-build-manifest.json',JSON.stringify({
  keys:Object.keys(values).sort(),sha256:createHash('sha256').update(canonical).digest('hex'),
}));
