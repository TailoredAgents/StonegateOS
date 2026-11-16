// Enumerate only Next's publicly served static tree. Never read .next/server,
// environment variables or the server action encryption manifest.
export const staticInventory = String.raw`
const {readdirSync,lstatSync,readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const root='/app/apps/site/.next/static';const assets=[];let total=0;
function visit(relative=''){
 for(const name of readdirSync(root+'/'+relative)){
  const key=relative?relative+'/'+name:name;
  if(!/^[a-zA-Z0-9_./@()~\[\]-]+$/.test(key)||key.split('/').includes('..'))throw Error('Unexpected static path');
  const file=root+'/'+key;const info=lstatSync(file);
  if(info.isSymbolicLink())throw Error('Static symlink rejected');
  if(info.isDirectory()){visit(key);continue;}
  if(!info.isFile())throw Error('Unexpected static object');
  total+=info.size;if(total>32*1024*1024||assets.length>=1000)throw Error('Static inventory exceeds bound');
  const bytes=readFileSync(file);
  assets.push({key,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
}
visit();assets.sort((a,b)=>a.key.localeCompare(b.key));
console.log(JSON.stringify({assets,totalBytes:total}));
`;
