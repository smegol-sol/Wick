/**
 * Create the sealed execution key on the host (ADR-0003):
 *
 *   npm -w @wick/engine run vault:init -- [path] [--totp]
 *
 * Generates a fresh keypair, seals it with a passphrase typed twice (never
 * echoed), writes the vault file, and prints the wallet address to fund by
 * hand. With `--totp` it also prints a fresh base32 secret and the otpauth
 * URI for the authenticator app; put the secret in `.env` as TOTP_SECRET.
 * Nothing here ever prints the key.
 */
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createHot, lockHotMem, passOk } from "@wick/core/hot-wallet";
import { base32Encode, otpauthUri } from "@wick/core/totp";

function askHidden(prompt: string): Promise<string> {
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantTotp = args.includes("--totp");
  const file = args.find((a) => !a.startsWith("--")) ?? process.env.VAULT_FILE ?? "vault.json";
  if (existsSync(file)) {
    console.error(`${file} exists; refusing to overwrite a vault. Move it away first.`);
    process.exit(2);
  }
  const pass = await askHidden("Passphrase (10 to 128 characters): ");
  if (!passOk(pass)) {
    console.error("Passphrase refused: too short, too long, or a known weak pattern.");
    process.exit(2);
  }
  const again = await askHidden("Again: ");
  if (again !== pass) {
    console.error("Passphrases differ.");
    process.exit(2);
  }
  const { vault } = await createHot(pass);
  lockHotMem();
  writeFileSync(file, JSON.stringify(vault, null, 2) + "\n", { mode: 0o600 });
  console.log(`vault written: ${file}`);
  console.log(`execution wallet: ${vault.pub}`);
  console.log(
    "Fund it by hand from the main wallet, up to the tier cap in risk.yaml. Never above.",
  );
  if (wantTotp) {
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    console.log(`\nTOTP_SECRET=${secret}`);
    console.log(otpauthUri(secret, vault.pub.slice(0, 8)));
    console.log(
      "Add the secret to .env and scan the URI in the authenticator app before the first unseal.",
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
