// Run only in the manually dispatched recovery workflow. The artifact contains
// RSA-encrypted key material; the plaintext AES key never becomes an artifact.
import { createPublicKey, publicEncrypt, createHash, constants } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const encodedKey = process.env.BACKUP_KEY_BASE64 ?? '';
const recipient = process.env.RECIPIENT_PUBLIC_KEY ?? '';
const backupId = process.env.BACKUP_ID || 'recovery-20261115-v2';
if (!['recovery-20261115-v2', 'recovery-20261116-timed-v2'].includes(backupId)) throw Error('Unknown backup identity');
delete process.env.BACKUP_KEY_BASE64;
if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw Error('Recovery key unavailable');
if (recipient.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(recipient)) throw Error('Invalid recipient encoding');
const key = Buffer.from(encodedKey, 'base64');
try {
  const publicKey = createPublicKey(Buffer.from(recipient, 'base64'));
  if (publicKey.asymmetricKeyType !== 'rsa' ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 4096 ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) > 8192) throw Error('Recipient must use RSA 4096–8192');
  const ciphertext = publicEncrypt({key:publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key);
  const publicDer = publicKey.export({type:'spki',format:'der'});
  await mkdir('artifacts/recovery-key',{recursive:true,mode:0o700});
  await writeFile('artifacts/recovery-key/wrapped-key.json',JSON.stringify({
    backupId,algorithm:'RSA-OAEP-SHA256',
    recipientSha256:createHash('sha256').update(publicDer).digest('hex'),
    ciphertext:ciphertext.toString('base64'),
  },null,2),{flag:'wx',mode:0o600});
  console.log('Recovery key encrypted for the supplied recipient. No plaintext key was written.');
} finally {key.fill(0);}
