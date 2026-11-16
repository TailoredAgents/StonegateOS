// Runs in the pinned outbox image. No database, application server or queue
// consumer is started. Destinations and provider credentials are private input.
export const providerProbe = String.raw`
const config=JSON.parse(process.env.MIGRATION_PROVIDER_CONFIG);
const action=process.env.MIGRATION_PROVIDER_ACTION;
if(config.purpose!=='authorized-migration-deliveries'||!/^SG-CF-[a-f0-9]{12}$/.test(config.runId)||Date.parse(config.expiresAt)<=Date.now())throw Error('INVALID_TRIAL');
if(!/^\+[1-9]\d{7,14}$/.test(config.phone)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.email))throw Error('INVALID_DESTINATION');
const allowed=new Set(['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM','TWILIO_API_BASE_URL','TWILIO_WEBHOOK_PUBLIC_BASE_URL','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_SECURE','SMTP_TIMEOUT_MS','TEAM_KILL_EXTERNAL_SENDS']);
if(Object.keys(config.environment).some(k=>!allowed.has(k))||Object.values(config.environment).some(v=>typeof v!=='string'))throw Error('INVALID_ENVIRONMENT');
const environment={...config.environment,NODE_ENV:'production'};
if(['true','1','on'].includes(environment.TEAM_KILL_EXTERNAL_SENDS?.toLowerCase()))throw Error('EXTERNAL_SENDS_DISABLED');
const {registerApiAliases}=require('/app/scripts/lib/register-api-aliases.ts');registerApiAliases();
const {createTwilioProviderMessage,inspectTwilioProviderConfiguration}=require('/app/apps/api/src/lib/twilio-provider.ts');
const {sendEmailThroughProvider,getEmailProviderConfiguration}=require('/app/apps/api/src/lib/email-provider.ts');
const {getTwilioApiBaseUrl}=require('/app/packages/sdk/src/twilio-provider.ts');
const {createRequire}=require('node:module');
const nodemailer=createRequire('/app/apps/api/package.json')('nodemailer');
const base=getTwilioApiBaseUrl(environment);
const headers={authorization:'Basic '+Buffer.from(environment.TWILIO_ACCOUNT_SID+':'+environment.TWILIO_AUTH_TOKEN).toString('base64')};
async function twilio(path){const r=await fetch(new URL(path,base),{headers,redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Object.assign(Error('TWILIO_READ_FAILED'),{code:'HTTP_'+r.status});return r.json();}
(async()=>{try{
 if(action==='preflight'){
  const sms=inspectTwilioProviderConfiguration(environment);
  if(!sms.ok)throw Object.assign(Error('SMS_CONFIGURATION'),{code:sms.code});
  const account=await twilio('/2010-04-01/Accounts/'+environment.TWILIO_ACCOUNT_SID+'.json');
  if(account.sid!==environment.TWILIO_ACCOUNT_SID||account.status!=='active')throw Error('TWILIO_ACCOUNT_INACTIVE');
  const c=getEmailProviderConfiguration(environment);if(!c)throw Error('EMAIL_NOT_CONFIGURED');
  const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.secure,requireTLS:c.requireTls,connectionTimeout:c.timeoutMs,greetingTimeout:c.timeoutMs,socketTimeout:c.timeoutMs,...(c.user&&c.pass?{auth:{user:c.user,pass:c.pass}}:{})});
  try{await transport.verify();}finally{transport.close();}
  console.log(JSON.stringify({ok:true,smsAccountActive:true,smtpVerified:true,smtpPort:c.port,smtpTls:c.secure||c.requireTls}));
 }else if(action==='sms'){
  const r=await createTwilioProviderMessage({to:config.phone,body:'StonegateOS migration test from Cloudflare. No action needed. Reference '+config.runId+'.'},{environment,timeoutMs:15000});
  console.log(JSON.stringify(r.ok?{ok:true,certainty:'accepted',providerMessageId:r.messageSid}:{ok:false,certainty:r.certainty==='not_applied'?'rejected':'uncertain',code:r.code,status:r.status}));
 }else if(action==='email'){
  const r=await sendEmailThroughProvider({to:config.email,subject:'StonegateOS Cloudflare migration test '+config.runId,text:'This is the authorized StonegateOS migration email test sent from the Cloudflare candidate using the existing email provider. No booking or payment was created. Reference: '+config.runId,idempotencyKey:config.runId+':email'},environment);
  console.log(JSON.stringify({ok:r.ok,certainty:r.deliveryCertainty==='ambiguous'?'uncertain':r.deliveryCertainty,providerMessageId:r.providerMessageId,acceptedRecipientCount:r.acceptedRecipientCount,rejectedRecipientCount:r.rejectedRecipientCount,code:r.detail}));
 }else if(action==='sms-status'){
  const sid=process.env.MIGRATION_MESSAGE_SID;if(!/^SM[a-f0-9]{32}$/i.test(sid))throw Error('INVALID_MESSAGE_ID');
  const r=await twilio('/2010-04-01/Accounts/'+environment.TWILIO_ACCOUNT_SID+'/Messages/'+sid+'.json');
  if(r.sid!==sid||r.to!==config.phone||r.from!==environment.TWILIO_FROM)throw Error('MESSAGE_SCOPE_MISMATCH');
  console.log(JSON.stringify({ok:true,status:r.status,errorCode:r.error_code??null,providerMessageId:sid}));
 }else throw Error('INVALID_ACTION');
}catch(error){console.log(JSON.stringify({ok:false,certainty:'uncertain',code:/^[A-Za-z0-9_]{1,80}$/.test(error.code??'')?error.code:'PROVIDER_PROBE_FAILED'}));process.exitCode=1;}})();
`;
