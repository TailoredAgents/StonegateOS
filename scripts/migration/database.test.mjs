import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encrypt, decrypt, compare } from './database.mjs';

test('encrypted backup round-trips and rejects corruption and a wrong key', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'stonegate-backup-test-'));
  try {
    const file=path.join(dir,'dump');const key=randomBytes(32);const payload=randomBytes(1024*1024);
    await encrypt(Readable.from(payload),file,key);
    const chunks=[];
    await decrypt(file,new Writable({write(chunk,_encoding,done){chunks.push(chunk);done();}}),key);
    assert.deepEqual(Buffer.concat(chunks),payload);
    const discard=()=>new Writable({write(_c,_e,done){done();}});
    await assert.rejects(decrypt(file,discard(),randomBytes(32)));
    const damaged=await readFile(file);damaged[100]^=1;await writeFile(file,damaged);
    await assert.rejects(decrypt(file,discard(),key));
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('verification catches missing tables, changed counts and changed contents', () => {
  const base={schema:[],constraints:[],indexes:[],enums:[],sequences:[],extensions:[],largeObjects:'0',tables:[{name:'payments',rows:2,sha256:'original'}]};
  assert.deepEqual(compare(base,structuredClone(base)),[]);
  for(const tables of [[],[{name:'payments',rows:1,sha256:'original'}],[{name:'payments',rows:2,sha256:'different'}]]) {
    assert.deepEqual(compare(base,{...base,tables}),['tables']);
  }
});
test('enum labels retain order even when PostgreSQL renumbers internal positions',()=>{
  const base={schema:[],constraints:[],indexes:[],sequences:[],extensions:[],largeObjects:'0',tables:[],enums:[{name:'stage',label:'new',position:1},{name:'stage',label:'inserted',position:1.5},{name:'stage',label:'done',position:2}]};
  const renumbered={...base,enums:base.enums.map((e,i)=>({...e,position:i+1}))};
  assert.deepEqual(compare(base,renumbered),[]);
  assert.deepEqual(compare(base,{...renumbered,enums:[...renumbered.enums].reverse()}),['enums']);
  assert.deepEqual(compare(base,{...renumbered,enums:renumbered.enums.slice(1)}),['enums']);
});
