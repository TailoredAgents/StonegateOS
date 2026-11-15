import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
const requireApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const execute = promisify(execFile);
const source = (await readFile(new URL('./source-revision', import.meta.url),'utf8')).trim();
async function nativeChecks() {
  const sharp = requireApi('sharp');
  const argon = requireApi('@node-rs/argon2');
  const ffmpeg = requireApi('ffmpeg-static');
  const image = await sharp({create:{width:8,height:8,channels:4,background:'#ffffff'}}).png().toBuffer();
  const password='synthetic-migration-password';
  if (!await argon.verify(await argon.hash(password),password)) throw new Error('argon2 round-trip failed');
  const { stdout }=await execute(ffmpeg,['-version'],{timeout:15000,maxBuffer:65536});
  const React=requireApi('react');
  const pdf=await import(requireApi.resolve('@react-pdf/renderer'));
  const document=React.createElement(pdf.Document,null,React.createElement(pdf.Page,null,React.createElement(pdf.Text,null,'Synthetic migration validation')));
  const documentBytes=await pdf.renderToBuffer(document);
  return {ok:true,source,node:process.version,sharpBytes:image.length,argon2:true,ffmpeg:stdout.split('\n')[0],pdfBytes:documentBytes.length};
}
if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify(await nativeChecks()));
} else {
  createServer(async (request,response)=>{
    response.setHeader('content-type','application/json');
    response.setHeader('cache-control','no-store');
    try {
      if(request.method==='GET' && request.url==='/api/healthz') response.end(JSON.stringify({ok:true,source,node:process.version,mode:'probe'}));
      else if(request.method==='POST' && request.url==='/native-check') response.end(JSON.stringify(await nativeChecks()));
      else {response.statusCode=404;response.end('{}');}
    } catch {response.statusCode=503;response.end(JSON.stringify({ok:false,error:'native_check_failed'}));}
  }).listen(8080,'0.0.0.0');
}
