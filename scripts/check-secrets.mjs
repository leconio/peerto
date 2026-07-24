import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const root = process.cwd();
const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const ignoredExtensions = new Set([
  ".ico",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
]);
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isFile() || ignoredExtensions.has(extname(entry.name))) {
      continue;
    }
    await inspect(path);
  }
}

async function inspect(path) {
  const file = relative(root, path);
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (content === undefined) return;

  check(
    file,
    content,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    "private key",
  );
  check(
    file,
    content,
    /(?:CLOUDFLARE_API_TOKEN|TURNSTILE_SECRET_KEY|TURN_PASSWORD|COTURN_PASSWORD)[ \t]*=[ \t]*["']?([A-Za-z0-9_+/=-]{24,})/g,
    "credential assignment",
  );
  check(
    file,
    content,
    /static-auth-secret\s*=\s*([A-Za-z0-9_+/=-]{24,})/g,
    "coturn static auth secret",
  );
  check(
    file,
    content,
    /user=[^:\s]+:([A-Za-z0-9_+/=-]{24,})/g,
    "coturn long-term password",
    (match) => match.includes("CHANGE_ME"),
  );

  for (const match of content.matchAll(
    /\bturns?:((?:[a-z0-9-]+\.)+[a-z]{2,}|localhost)(?=[:/?\s"'])/gi,
  )) {
    const hostname = match[1].toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".example.com") ||
      hostname.endsWith(".test")
    ) {
      continue;
    }
    addFinding(file, content, match.index, "non-example TURN endpoint");
  }
}

function check(file, content, pattern, label, ignore = () => false) {
  for (const match of content.matchAll(pattern)) {
    if (ignore(match[0])) continue;
    addFinding(file, content, match.index, label);
  }
}

function addFinding(file, content, index = 0, label) {
  const line = content.slice(0, index).split("\n").length;
  findings.push(`${file}:${line}: ${label}`);
}

try {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  for (const file of stdout.split("\0").filter(Boolean)) {
    await inspect(join(root, file));
  }
} catch {
  await walk(root);
}

if (findings.length > 0) {
  console.error("Potential secrets or private TURN endpoints found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Secret scan passed.");
