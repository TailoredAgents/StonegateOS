import { DurableObject } from 'cloudflare:workers';
import { createHash,timingSafeEqual } from 'node:crypto';
import { siteCheck } from './site-check';

class ValidationContainer extends DurableObject<Env> {
  private starting:Promise<void>|undefined;
  private observing:Promise<void>|undefined;
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    if(ctx.container?.running) {
      ctx.blockConcurrencyWhile(()=>ctx.container!.setInactivityTimeout(60000));
      this.observe();
    }
  }
  private observe():void {
    if(this.observing)return;
    this.observing=this.ctx.container!.monitor()
      .then(()=>console.log(JSON.stringify({event:'validation_container_stopped'})))
      .catch(()=>console.error(JSON.stringify({event:'validation_container_failed'})))
      .finally(()=>{this.observing=undefined;});
    this.ctx.waitUntil(this.observing);
  }
  private async ready():Promise<void> {
    const container=this.ctx.container!;
    if(!container.running) {
      container.start({image:container.images.base,instance:'basic',enableInternet:false});
    }
    this.observe();
    await container.setInactivityTimeout(60000);
    for(let attempt=0;attempt<120;attempt++) {
      try {
        const response=await container.getTcpPort(8080).fetch('http://container/api/healthz',{signal:AbortSignal.timeout(1000)});
        await response.body?.cancel();if(response.ok)return;
      } catch { /* Retry readiness only; never replay a business request. */ }
      await scheduler.wait(250);
    }
    throw new Error('Validation container readiness timeout');
  }
  async fetch(request:Request):Promise<Response> {
    const url=new URL(request.url);
    if(request.method==='POST' && url.pathname==='/stop') {
      if(this.starting)await this.starting;
      await this.ctx.container!.destroy();
      return Response.json({stopped:true},{headers:{'cache-control':'no-store'}});
    }
    this.starting??=this.ready().finally(()=>{this.starting=undefined;});
    await this.starting;
    if(request.method==='POST' && url.pathname==='/site-runtime-check') {
      const process=await this.ctx.container!.exec(['node','-e',siteCheck],{cwd:'/app',stdout:'pipe',stderr:'ignore',signal:AbortSignal.timeout(100000)});
      const result=await process.output();
      return new Response(result.stdout,{status:result.exitCode===0?200:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
    }
    if(url.pathname==='/image') return Response.json(await this.ctx.container!.inspect(),{headers:{'cache-control':'no-store'}});
    return this.ctx.container!.getTcpPort(8080).fetch(new Request(`http://container${url.pathname}`,request));
  }
}
export class SiteValidation extends ValidationContainer {}
export class ApiValidation extends ValidationContainer {}
export class OutboxValidation extends ValidationContainer {}
export class DiscordValidation extends ValidationContainer {}

export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    const authorization=request.headers.get('authorization')??'';
    if(!env.MIGRATION_PROBE_TOKEN || authorization.length>512 || !timingSafeEqual(
      createHash('sha256').update(authorization).digest(),createHash('sha256').update(`Bearer ${env.MIGRATION_PROBE_TOKEN}`).digest())) {
      return Response.json({error:'unauthorized'},{status:401,headers:{'cache-control':'no-store'}});
    }
    const url=new URL(request.url);
    const [,service,...parts]=url.pathname.split('/');
    const route='/'+parts.join('/');
    const namespace=service==='site'?env.SITE:service==='api'?env.API:service==='outbox'?env.OUTBOX:service==='discord'?env.DISCORD:null;
    const valid=(request.method==='GET' && ['/api/healthz','/image'].includes(route)) || (request.method==='POST' && ['/native-check','/stop'].includes(route)) || (service==='site' && request.method==='POST' && route==='/site-runtime-check');
    if(!namespace || !valid)return Response.json({error:'not_found'},{status:404});
    try {
      return await namespace.getByName('validation-v1',{locationHint:'enam'}).fetch(new Request(`https://validation.internal${route}`,request));
    } catch {
      console.error(JSON.stringify({event:'container_probe_failed',service}));
      return Response.json({error:'container_unavailable'},{status:503,headers:{'cache-control':'no-store'}});
    }
  },
} satisfies ExportedHandler<Env>;
