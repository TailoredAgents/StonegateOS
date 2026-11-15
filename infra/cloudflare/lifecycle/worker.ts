import {DurableObject} from 'cloudflare:workers';
import {createHash,timingSafeEqual} from 'node:crypto';

// A bounded diagnostic: no provider/database credentials, no outbound network,
// and no promise that monitors the Container indefinitely. Future alarms do not
// prevent the object from hibernating between health checks.
export class LifecycleValidation extends DurableObject<Env> {
  private objectExecutionId=crypto.randomUUID();
  async alarm():Promise<void> {
    const expires=await this.ctx.storage.get<number>('expires');
    if(!expires || Date.now()>=expires){await this.stop();return;}
    const snapshot=await this.inspect();
    await this.ctx.storage.put('lastAlarm',{at:Date.now(),objectExecutionId:this.objectExecutionId,...snapshot});
    await this.ctx.storage.setAlarm(Math.min(expires,Date.now()+90000));
  }
  private async stop() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('expires');
    await this.ctx.container!.destroy();
  }
  private async inspect() {
    const c=this.ctx.container!;
    if(!c.running)return {running:false,healthy:false,validationId:null};
    const info=await c.inspect();
    if(!info)return {running:false,healthy:false,validationId:null};
    try {
      const response=await c.getTcpPort(8080).fetch('http://container/api/healthz',{signal:AbortSignal.timeout(3000)});
      await response.body?.cancel();return {running:true,healthy:response.ok,validationId:info.labels.validationId};
    }catch{return {running:true,healthy:false,validationId:info.labels.validationId};}
  }
  async fetch(request:Request):Promise<Response> {
    const route=new URL(request.url).pathname;
    if(route==='/stop'){await this.stop();return Response.json({stopped:true});}
    if(route==='/start') {
      const c=this.ctx.container!;
      if(c.running)return Response.json({error:'already_running'},{status:409});
      const validationId=crypto.randomUUID();
      c.start({image:c.images.base,instance:'basic',enableInternet:false,labels:{validationId}});
      await c.setInactivityTimeout(180000);
      const expires=Date.now()+10*60*1000;
      await this.ctx.storage.put('expires',expires);
      await this.ctx.storage.delete('lastAlarm');
      await this.ctx.storage.setAlarm(Date.now()+90000);
      return Response.json({validationId,expires,objectExecutionId:this.objectExecutionId});
    }
    return Response.json({...await this.inspect(),objectExecutionId:this.objectExecutionId,lastAlarm:await this.ctx.storage.get('lastAlarm'),expires:await this.ctx.storage.get('expires')});
  }
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    const token=request.headers.get('authorization')??'';
    if(!env.MIGRATION_PROBE_TOKEN || token.length>512 || !timingSafeEqual(createHash('sha256').update(token).digest(),
      createHash('sha256').update(`Bearer ${env.MIGRATION_PROBE_TOKEN}`).digest()))return Response.json({error:'unauthorized'},{status:401});
    const route=new URL(request.url).pathname;
    if(!((request.method==='POST'&&['/start','/stop'].includes(route))||(request.method==='GET'&&route==='/status')))return new Response(null,{status:404});
    return env.LIFECYCLE.getByName('bounded-idle-validation',{locationHint:'enam'}).fetch(request);
  },
} satisfies ExportedHandler<Env>;
