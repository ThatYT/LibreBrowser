/**
 * Invite-link CLI.
 * Mints HMAC-signed {sid, role, exp} tokens (gateway/src/auth/invite.ts) and prints the join
 * URL with the token in the FRAGMENT (never the query string — keeps it out of access logs).
 */
import { mintInvite, type SessionRole } from "../packages/gateway/src/auth/invite";

const [sid, rawRole, rawTtl = "3600", rawOrigin = process.env.MIRROR_PUBLIC_ORIGIN] =
  process.argv.slice(2);
const secret = process.env.MIRROR_AUTH_SECRET;

if (
  sid === undefined ||
  (rawRole !== "driver" && rawRole !== "viewer") ||
  rawOrigin === undefined ||
  secret === undefined ||
  secret.length === 0
) {
  fail(
    "Usage: MIRROR_AUTH_SECRET=<secret> pnpm exec tsx scripts/invite.ts " +
      "<sid> <driver|viewer> [ttl-seconds] [https://host]",
  );
}

const ttl = Number(rawTtl);
if (!Number.isSafeInteger(ttl) || ttl < 1) fail("ttl-seconds must be a positive integer");

let origin: URL;
try {
  origin = new URL(rawOrigin);
} catch {
  fail("origin must be an absolute http(s) URL");
}
if (
  (origin.protocol !== "https:" && origin.protocol !== "http:") ||
  origin.pathname !== "/" ||
  origin.search !== "" ||
  origin.hash !== ""
) {
  fail("origin must contain only an http(s) scheme and host");
}

const role: SessionRole = rawRole;
const exp = Math.floor(Date.now() / 1_000) + ttl;
const token = mintInvite({ sid, role, exp }, Buffer.from(secret, "utf8"));
process.stdout.write(`${origin.origin}/join#${token}\n`);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
