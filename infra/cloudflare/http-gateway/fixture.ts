// No provider credentials or outbound networking. The production-sized image
// runs this fixed transport fixture only during gateway acceptance testing.
export const fixture = String.raw`
const {createServer}=require('node:http');
const {createHash}=require('node:crypto');
let mutations=0;let slowWrites=0;let accepting=true;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://container');
 if(!accepting){res.writeHead(503);res.end();return;}
 if(url.pathname==='/api/healthz'){res.end('ok');return;}
 if(url.pathname==='/counts'){res.setHeader('content-type','application/json');res.end(JSON.stringify({mutations,slowWrites}));return;}
 if(url.pathname==='/lost-response'){mutations++;req.socket.destroy();return;}
 if(url.pathname==='/redirect'){res.writeHead(307,{location:'/landing?next=%2Fteam'});res.end();return;}
 if(url.pathname==='/cookies'){res.setHeader('set-cookie',['session=one; Path=/; HttpOnly; Secure; SameSite=Lax','state=two; Path=/; Secure; SameSite=Strict']);res.end('cookies');return;}
 if(url.pathname==='/stream'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write('data: first\n\n');setTimeout(()=>res.end('data: second\n\n'),1800);return;}
 if(url.pathname==='/slow-write'){setTimeout(()=>{slowWrites++;res.end(JSON.stringify({committed:true,slowWrites}));},2200);return;}
 if(url.pathname==='/empty'){res.writeHead(204);res.end();return;}
 const hash=createHash('sha256');let bytes=0;
 try{for await(const chunk of req){hash.update(chunk);bytes+=chunk.length;}}
 catch{return;}
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify({method:req.method,url:req.url,headers:req.headers,bytes,sha256:hash.digest('hex')}));
});
server.listen(8080,'0.0.0.0');
process.on('SIGTERM',()=>{accepting=false;server.close(()=>process.exit(0));});
`;
