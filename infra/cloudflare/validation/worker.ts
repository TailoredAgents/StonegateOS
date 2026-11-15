import { createHash, timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';

function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.length > 512) return false;
  return timingSafeEqual(createHash('sha256').update(authorization).digest(),
    createHash('sha256').update(`Bearer ${secret}`).digest());
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, {status, headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env.MIGRATION_PROBE_TOKEN)) return json({error:'unauthorized'},401);
    const url = new URL(request.url);
    const bucket = url.searchParams.get('bucket') === 'legacy' ? env.LEGACY : env.MEDIA;
    try {
      if (request.method === 'GET' && url.pathname === '/database-check') {
        const sql=postgres(env.RESTORE_DB.connectionString,{max:1,fetch_types:false,prepare:true,connect_timeout:10,idle_timeout:1,max_lifetime:30});
        try {
          const [state]=await sql`select current_database() as database,
            current_user as role, current_setting('transaction_read_only') as read_only,
            (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname in ('public','drizzle') and c.relkind='r') as tables,
            (select count(*)::int from public.contacts) as contacts,
            (select count(*)::int from public.appointments) as appointments,
            (select count(*)::int from public.outbox_events) as outbox_events`;
          const ok=state.database.startsWith('stonegate_restore_') && state.role==='stonegate_validation_ro' && state.read_only==='on';
          return json({ok,...state},ok?200:503);
        } finally {await sql.end({timeout:2});}
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        await env.VALIDATION.list({limit:1});
        return json({ok:true,purpose:'migration-validation',customerTraffic:false});
      }
      if (request.method === 'GET' && url.pathname === '/inventory') {
        const cursor = url.searchParams.get('cursor') ?? undefined;
        if (cursor && cursor.length > 2048) return json({error:'cursor_too_long'},400);
        const objects = await bucket.list({limit:250,cursor});
        return json({objects:objects.objects.map(object=>({key:object.key,size:object.size,etag:object.etag,uploaded:object.uploaded})),
          cursor:objects.truncated ? objects.cursor : null});
      }
      if (request.method === 'POST' && url.pathname === '/verify') {
        const length=Number(request.headers.get('content-length'));
        if (!Number.isSafeInteger(length) || length < 1 || length > 16384) return json({error:'invalid_length'},413);
        // The client must supply a bounded body; streaming reads enforce the bound too.
        const reader=request.body?.getReader();
        if (!reader) return json({error:'body_required'},400);
        let size=0;const chunks:Uint8Array[]=[];
        while(true) {const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
          if(size>16384){await reader.cancel();return json({error:'body_too_large'},413);}chunks.push(next.value);}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
        const keys:unknown=JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(keys) || keys.length > 16 || keys.some(key=>typeof key !== 'string' || key.length > 1024)) return json({error:'invalid_keys'},400);
        const results=[];
        for (const key of keys as string[]) {
          const object=await bucket.get(key);
          if (!object) {results.push({key,missing:true});continue;}
          const hash=createHash('sha256');let bytes=0;
          for await (const chunk of object.body) {hash.update(chunk);bytes+=chunk.byteLength;}
          results.push({key,size:bytes,sha256:hash.digest('hex'),etag:object.etag});
        }
        return json({objects:results});
      }
      if (request.method === 'POST' && url.pathname === '/r2-roundtrip') {
        const key=`synthetic/${crypto.randomUUID()}`;
        const payload=`stonegate-validation-${crypto.randomUUID()}`;
        try {
          await env.VALIDATION.put(key,payload,{httpMetadata:{contentType:'text/plain'}});
          const result=await env.VALIDATION.get(key);
          if (!result || await result.text() !== payload) throw new Error('roundtrip');
        } finally {await env.VALIDATION.delete(key);}
        if (await env.VALIDATION.head(key)) throw new Error('delete');
        return json({ok:true,put:true,get:true,delete:true});
      }
      return json({error:'not_found'},404);
    } catch(error) {
      // Avoid logging keys, payloads or credentials from production media checks.
      const code=error && typeof error==='object' && 'code' in error && typeof error.code==='string' && /^[A-Z0-9_]{1,50}$/.test(error.code)?error.code:'UNKNOWN';
      console.error(JSON.stringify({event:'migration_validation_failed',operation:url.pathname,code}));
      return json({error:'validation_failed',code},503);
    }
  },
} satisfies ExportedHandler<Env>;
