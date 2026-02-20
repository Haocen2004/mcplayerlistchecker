import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ALGORITHM = 'aes-256-cbc';
const CACHE_PATH = path.join(process.cwd(), 'auth_cache.enc');

export function encrypt(text: string, key: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, crypto.scryptSync(key, 'salt', 32), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

export function decrypt(text: string, key: string): string {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift()!, 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, crypto.scryptSync(key, 'salt', 32), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

export function saveEncrypted(data: any, key: string) {
    const json = JSON.stringify(data);
    const encrypted = encrypt(json, key);
    fs.writeFileSync(CACHE_PATH, encrypted);
}

export function loadEncrypted(key: string): any | null {
    if (!fs.existsSync(CACHE_PATH)) return null;
    try {
        const encrypted = fs.readFileSync(CACHE_PATH, 'utf8');
        const decrypted = decrypt(encrypted, key);
        return JSON.parse(decrypted);
    } catch (e) {
        console.error('[Auth] Failed to decrypt cache. Key might be wrong.');
        return null;
    }
}
