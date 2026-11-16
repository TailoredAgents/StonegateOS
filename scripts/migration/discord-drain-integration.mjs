// Exercise the real bot's event handler with an in-process transport simulator.
// No Discord credential, customer message, database or provider is accessed.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';

const directory=await mkdtemp(path.join(tmpdir(),'stonegate-discord-drain-'));
const hook=path.join(directory,'transport.cjs');
await writeFile(hook,String.raw`
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const original=Module._load;
global.fetch=()=>Promise.reject(Error('Unexpected network access in Discord drain test'));
Module._load=function(name,...args){
 const sdk=original.call(this,name,...args);
 if(name!=='discord.js')return sdk;
 class FixtureClient extends EventEmitter {
  user={id:'fixture-bot'};guilds={cache:new Map()};
  async login(token){
   if(token!=='synthetic-discord-token')throw Error('Unexpected credential');
   queueMicrotask(()=>{this.emit(sdk.Events.ClientReady);setTimeout(()=>this.emitMessage(),100);});
   return token;
  }
  emitMessage(){this.emit(sdk.Events.MessageCreate,{author:{id:'fixture-user',bot:false},guildId:'fixture-guild',channelId:'fixture-channel',content:'!sg',inGuild:()=>true,
   reply:async()=>{console.log(JSON.stringify({event:'fixture.reply.started'}));setTimeout(()=>this.emitMessage(),200);await new Promise(r=>setTimeout(r,1500));console.log(JSON.stringify({event:'fixture.reply.completed'}));return{id:'fixture-reply'};}});}
  async destroy(){console.log(JSON.stringify({event:'fixture.gateway.disconnected'}));this.removeAllListeners();}
 }
 return {...sdk,Client:FixtureClient};
};
`,{mode:0o600});
const tsx=createRequire(import.meta.url).resolve('tsx');
const child=spawn(process.execPath,['--require',hook,'--import',tsx,'scripts/discord-agent-bot.ts'],{
 cwd:process.cwd(),stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'',...(process.env.NODE_PATH?{NODE_PATH:process.env.NODE_PATH}:{}),
 NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',DISCORD_BOT_TOKEN:'synthetic-discord-token',AGENT_BOT_SHARED_SECRET:'synthetic-agent-secret',
 DISCORD_GUILD_ID:'fixture-guild',DISCORD_REPORTS_ENABLED:'false',DISCORD_MEMORY_ENABLED:'false',DISCORD_AGENT_SITE_URL:'http://127.0.0.1:1'}});
let stdout='';let stderr='';
child.stdout.on('data',chunk=>{if(stdout.length<65536)stdout+=chunk.toString();});
child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk.toString();});
const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
try {
 for(let i=0;i<150&&!stdout.includes('fixture.reply.started');i++){if(child.exitCode!==null)break;await wait(100);}
 if(!stdout.includes('fixture.reply.started'))throw Error('Real Discord handler did not reach fixture reply: '+stderr.slice(-2000));
 child.kill('SIGTERM');await wait(100);
 if(child.exitCode!==null)throw Error('Discord exited before its accepted reply settled');
 let timer;const code=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Discord drain timeout')),10000);})]).finally(()=>clearTimeout(timer));
 const events=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line).event];}catch{return[];}});
 const expected=['fixture.reply.started','discord.worker.draining','fixture.reply.completed','fixture.gateway.disconnected','discord.worker.drained'];
 if(code!==0||JSON.stringify(events.filter(Boolean))!==JSON.stringify(expected))throw Error('Discord drain order/admission failed: '+JSON.stringify({code,events}));
 console.log(JSON.stringify({ok:true,realHandler:true,inFlightCompleted:true,newEventRejected:true,disconnectedAfterDrain:true,exitCode:code}));
}finally{if(child.exitCode===null)child.kill('SIGKILL');await exited.catch(()=>{});await rm(directory,{recursive:true,force:true});}
