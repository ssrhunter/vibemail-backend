import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../../../src/providers/gmail/encryption';

describe('encryption (AES-256-GCM)', () => {
  it('round-trips a plaintext value through encrypt/decrypt', () => {
    const plaintext = 'ya29.a0AfH6SMB-example-access-token';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('never stores the plaintext value inside the ciphertext string', () => {
    const plaintext = 'super-secret-refresh-token-value';
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toContain(plaintext);
  });

  it('produces a different ciphertext each time (random IV) for the same plaintext', () => {
    const plaintext = 'same-input-both-times';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it('packs the ciphertext as iv:authTag:ciphertext (three base64 segments)', () => {
    const ciphertext = encrypt('whatever');
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow();
    }
  });

  it('throws when decrypting a tampered ciphertext (auth tag mismatch)', () => {
    const ciphertext = encrypt('tamper test');
    const [iv, authTag, data] = ciphertext.split(':');
    const tamperedDataBuffer = Buffer.from(data, 'base64');
    tamperedDataBuffer[0] = tamperedDataBuffer[0] ^ 0xff;
    const tampered = [iv, authTag, tamperedDataBuffer.toString('base64')].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on a malformed payload that is not iv:authTag:ciphertext', () => {
    expect(() => decrypt('not-the-right-shape')).toThrow();
  });
});
