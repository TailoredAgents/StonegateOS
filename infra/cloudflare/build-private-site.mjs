// This entrypoint is exclusively for the private Cloudflare registry workflow.
// The existing Render action key must never enter the public GHCR images.
import { readFileSync, writeFileSync } from 'node:fs';
if(process.env.STONEGATE_PRIVATE_SITE_BUILD!=='1')throw Error('Private site build guard is required');
const prior=JSON.parse(readFileSync('/run/secrets/site_compatibility','utf8'));
if(typeof prior.actionKey!=='string'||Buffer.from(prior.actionKey,'base64').length!==32||
 !Array.isArray(prior.actionIds)||!prior.actionIds.length||prior.actionIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{40,64}$/.test(id)))throw Error('Invalid private compatibility manifest');
process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=prior.actionKey;
try {await import('./build-site.mjs');}
finally {delete process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;}
const built=JSON.parse(readFileSync('/app/apps/site/.next/server/server-reference-manifest.json','utf8'));
const actual=Object.keys(built.node??{}).sort();const expected=[...prior.actionIds].sort();
const missing=expected.filter(id=>!actual.includes(id));const added=actual.filter(id=>!expected.includes(id));
if(built.encryptionKey!==prior.actionKey||missing.length||added.length)throw Error(`Server action compatibility failed: missing=${missing.length}, added=${added.length}`);
writeFileSync('/app/infra/cloudflare/site-action-compatibility.json',JSON.stringify({
 ok:true,existingActionCount:expected.length,actionIdsMatch:true,encryptionKeyMatches:true,
 priorBuildId:prior.buildId,buildId:readFileSync('/app/apps/site/.next/BUILD_ID','utf8').trim(),
}));
console.log(JSON.stringify({event:'site.legacy_actions_verified',count:expected.length}));
