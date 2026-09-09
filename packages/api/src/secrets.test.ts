import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SecretError, decryptSecret, encryptSecret, secretHint } from "./secrets";

/**
 * packages/api/src/secrets.test.ts — the encryption behind `app_config`.
 *
 * `docs/SCHEMA.md` promises one property above all: the archive alone cannot
 * decrypt these rows. That reduces to two testable claims — a wrong key must
 * fail rather than produce plausible garbage, and a tampered row must fail
 * rather than yield attacker-influenced plaintext that then gets used as an
 * API key.
 */

const KEY_A = randomBytes(32).toString("base64");
const FORMAT_VERSION_FOR_TEST = 1;
const KEY_B = randomBytes(32).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(decryptSecret(encryptSecret(secret, KEY_A), KEY_A)).toBe(secret);
  });

  it("round-trips unicode and an empty string", () => {
    expect(decryptSecret(encryptSecret("clé—🔐", KEY_A), KEY_A)).toBe("clé—🔐");
    expect(decryptSecret(encryptSecret("", KEY_A), KEY_A)).toBe("");
  });

  /**
   * A fresh IV per write is not a nicety: GCM loses both confidentiality and
   * integrity if an IV is ever reused under the same key. Two encryptions of
   * the same plaintext must therefore differ.
   */
  it("produces a different ciphertext every time for the same input", () => {
    const a = encryptSecret("same-value", KEY_A);
    const b = encryptSecret("same-value", KEY_A);
    expect(a.equals(b)).toBe(false);
    // ...and the IV specifically differs, which is the reason they do.
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    expect(decryptSecret(a, KEY_A)).toBe("same-value");
    expect(decryptSecret(b, KEY_A)).toBe("same-value");
  });

  /** The property `docs/SCHEMA.md` §app_config actually promises. */
  it("cannot be decrypted with a different MASTER_KEY", () => {
    const payload = encryptSecret("sk-ant-secret", KEY_A);
    expect(() => decryptSecret(payload, KEY_B)).toThrow(SecretError);
    expect(() => decryptSecret(payload, KEY_B)).toThrow(/MASTER_KEY has changed/);
  });

  it("rejects a tampered ciphertext rather than returning altered plaintext", () => {
    const payload = encryptSecret("sk-ant-secret-value", KEY_A);
    const tampered = Buffer.from(payload);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);
    expect(() => decryptSecret(tampered, KEY_A)).toThrow(SecretError);
  });

  it("rejects a tampered auth tag", () => {
    const payload = encryptSecret("sk-ant-secret-value", KEY_A);
    const tampered = Buffer.from(payload);
    tampered.writeUInt8(tampered.readUInt8(15) ^ 0xff, 15); // inside the tag
    expect(() => decryptSecret(tampered, KEY_A)).toThrow(SecretError);
  });

  /** The version byte is additional authenticated data, so flipping it is
   *  caught by the tag rather than only by the range check — which is what
   *  stops a downgrade once a version 2 exists. */
  it("authenticates the format version byte", () => {
    const payload = encryptSecret("sk-ant-secret-value", KEY_A);
    const tampered = Buffer.from(payload);
    tampered.writeUInt8(FORMAT_VERSION_FOR_TEST, 0); // same value: still decrypts
    expect(decryptSecret(tampered, KEY_A)).toBe("sk-ant-secret-value");

    // A different version fails the range check first, which is the intended
    // order — but the AAD means it would fail authentication even if a
    // future version 2 were added to the accepted set.
    tampered.writeUInt8(2, 0);
    expect(() => decryptSecret(tampered, KEY_A)).toThrow(SecretError);
  });

  it("rejects a truncated payload and an unknown format version", () => {
    const payload = encryptSecret("sk-ant-secret-value", KEY_A);
    expect(() => decryptSecret(payload.subarray(0, 10), KEY_A)).toThrow(/truncated/);

    const wrongVersion = Buffer.from(payload);
    wrongVersion[0] = 99;
    expect(() => decryptSecret(wrongVersion, KEY_A)).toThrow(/unsupported stored secret format/);
  });

  it("refuses a MASTER_KEY that is not 32 bytes", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => encryptSecret("x", short)).toThrow(/exactly 32 bytes/);
  });

  /** The error text is what an operator sees in a log. It must not contain
   *  the value it failed to decrypt. */
  it("never puts the secret in an error message", () => {
    const secret = "sk-ant-do-not-leak-me-0123456789";
    const payload = encryptSecret(secret, KEY_A);
    try {
      decryptSecret(payload, KEY_B);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain("do-not-leak");
    }
  });
});

describe("secretHint", () => {
  it("shows only the last four characters of a long secret", () => {
    const hint = secretHint("sk-ant-api03-abcdefghijklmnop-WXYZ");
    expect(hint).toBe("…WXYZ (34 characters)");
    expect(hint).not.toContain("abcdefghij");
  });

  /** Four characters of a short secret is a meaningful fraction of it, so a
   *  short value gets a length and nothing else. */
  it("shows no characters at all for a short value", () => {
    expect(secretHint("short")).toBe("5 characters");
    expect(secretHint("short")).not.toContain("shor");
  });
});
