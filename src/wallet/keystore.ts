import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';

interface KeystoreFile {
  version: 1;
  address: Hex;
  salt: string; // hex
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

const SCRYPT_N = 1 << 15;
// 128 * N * r bytes (~33.5MB at N=2^15, r=8) exceeds Node's 32MB default, so
// raise the cap explicitly rather than weakening the KDF.
const SCRYPT_OPTS = { N: SCRYPT_N, maxmem: 128 * 1024 * 1024 } as const;

/**
 * A minimal encrypted keystore for the hot (shadow) key. The key is sealed
 * with a passphrase via scrypt + AES-256-GCM and written 0600. This key is
 * deliberately low-value: under the shadow model it can only spend the owner's
 * budgeted tank via clock-in, never move funds — but we still never store it
 * in the clear.
 */
export function generateShadowKey(): { privateKey: Hex; address: Hex } {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return { privateKey, address };
}

export function saveKeystore(path: string, privateKey: Hex, passphrase: string): Hex {
  const address = privateKeyToAccount(privateKey).address;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT_OPTS);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey.slice(2), 'hex'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const file: KeystoreFile = {
    version: 1,
    address,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return address;
}

export function loadKeystore(path: string, passphrase: string): Hex {
  const file = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
  if (file.version !== 1) throw new Error(`unknown keystore version ${file.version}`);
  const key = scryptSync(passphrase, Buffer.from(file.salt, 'hex'), 32, SCRYPT_OPTS);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(file.authTag, 'hex'));
  try {
    const plaintext = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'hex')), decipher.final()]);
    return ('0x' + plaintext.toString('hex')) as Hex;
  } catch {
    throw new Error('failed to decrypt keystore: wrong passphrase or corrupt file');
  }
}

export function keystoreAddress(path: string): Hex {
  const file = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
  return file.address;
}
