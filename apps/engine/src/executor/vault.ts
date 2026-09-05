/**
 * The sealed execution key (ADR-0003). The file on disk is the WICK vault
 * format from core (PBKDF2 + AES-GCM). At boot the vault is sealed and the
 * executor idles; the owner unseals it from the console with the passphrase
 * and a TOTP code (ADR-0009). The key bytes live only inside this object
 * and leave it only as signatures.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { existsSync, readFileSync } from "node:fs";
import type { SealedKeyHandle } from "@wick/core/chain";
import { openVault, slimVault, toB58, type HotVault } from "@wick/core/hot-wallet";
import { verifyTotp } from "@wick/core/totp";

export type VaultState = "none" | "sealed" | "unsealed";

export type VaultErrorKind =
  "no-vault" | "second-factor-unset" | "bad-code" | "bad-passphrase" | "lockout";

export class VaultError extends Error {
  readonly kind: VaultErrorKind;
  constructor(kind: VaultErrorKind, msg: string) {
    super(msg);
    this.kind = kind;
  }
}

const FAIL_MAX = 5;
const LOCK_MS = 60_000;

export class Vault {
  private readonly file: string;
  private readonly totpSecret: Uint8Array | null;
  private readonly now: () => number;
  private vault: HotVault | null = null;
  private secret: Uint8Array | null = null;
  private fails = 0;
  private lockUntil = 0;
  private unsealedAt: number | null = null;

  constructor(file: string, totpSecret: Uint8Array | null, now: () => number = Date.now) {
    this.file = file;
    this.totpSecret = totpSecret;
    this.now = now;
    this.load();
  }

  /** Re-read the file; a vault written after boot is picked up on the next unseal. */
  load(): void {
    if (!existsSync(this.file)) {
      this.vault = null;
      return;
    }
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    const v = slimVault(raw);
    if (!v) throw new Error(`vault file ${this.file} is not a WICK vault`);
    this.vault = v;
  }

  get state(): VaultState {
    if (this.secret) return "unsealed";
    return this.vault ? "sealed" : "none";
  }

  /** The execution wallet's public key, known even while sealed. */
  get wallet(): string | null {
    return this.vault?.pub ?? null;
  }

  get since(): number | null {
    return this.unsealedAt;
  }

  get secondFactorConfigured(): boolean {
    return this.totpSecret != null;
  }

  async unseal(passphrase: string, code: string): Promise<SealedKeyHandle> {
    if (!this.vault) this.load();
    if (!this.vault) throw new VaultError("no-vault", "no vault file; run vault:init");
    if (!this.totpSecret)
      throw new VaultError("second-factor-unset", "TOTP_SECRET is unset; the vault stays sealed");
    const now = this.now();
    if (now < this.lockUntil)
      throw new VaultError("lockout", `locked for ${Math.ceil((this.lockUntil - now) / 1000)} s`);
    if (!(await verifyTotp(this.totpSecret, code, now))) {
      this.failed(now);
      throw new VaultError("bad-code", "second factor rejected");
    }
    let secret: Uint8Array;
    try {
      secret = await openVault(this.vault, passphrase);
    } catch {
      this.failed(now);
      throw new VaultError("bad-passphrase", "passphrase rejected");
    }
    const pub = toB58(ed25519.getPublicKey(secret.subarray(0, 32)));
    if (pub !== this.vault.pub) {
      secret.fill(0);
      this.failed(now);
      throw new VaultError("bad-passphrase", "vault key does not match its public key");
    }
    this.seal();
    this.secret = secret;
    this.fails = 0;
    this.lockUntil = 0;
    this.unsealedAt = now;
    return this.handle()!;
  }

  private failed(now: number): void {
    this.fails++;
    if (this.fails >= FAIL_MAX) this.lockUntil = now + LOCK_MS;
  }

  seal(): void {
    if (this.secret) this.secret.fill(0);
    this.secret = null;
    this.unsealedAt = null;
  }

  /** The signing handle while unsealed; null otherwise. The key never leaves. */
  handle(): SealedKeyHandle | null {
    const secret = this.secret;
    const wallet = this.vault?.pub;
    if (!secret || !wallet) return null;
    return {
      wallet,
      sign: (msg) => {
        if (this.secret !== secret) throw new Error("vault sealed");
        return ed25519.sign(msg, secret.subarray(0, 32));
      },
    };
  }
}
