import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const pairs = [
  ["README.md", "README.en.md"],
  ["ARCHITECTURE.md", "ARCHITECTURE.en.md"],
  ["CHANGELOG.md", "CHANGELOG.en.md"],
  ["CODE_OF_CONDUCT.md", "CODE_OF_CONDUCT.en.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.en.md"],
  ["REQUIREMENTS.md", "REQUIREMENTS.en.md"],
  ["SECURITY.md", "SECURITY.en.md"],
  ["docs/cloudflare.md", "docs/cloudflare.en.md"],
  ["docs/deployment.md", "docs/deployment.en.md"],
  ["docs/privacy.md", "docs/privacy.en.md"],
  ["docs/troubleshooting.md", "docs/troubleshooting.en.md"],
  ["docs/turn.md", "docs/turn.en.md"],
];
const ignoredDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
]);
const failures = [];

function count(text, pattern) {
  return text.match(pattern)?.length || 0;
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(path);
    }
  }
  return files;
}

for (const [chineseFile, englishFile] of pairs) {
  const chinesePath = join(root, chineseFile);
  const englishPath = join(root, englishFile);
  if (!(await exists(chinesePath)) || !(await exists(englishPath))) {
    failures.push(`${chineseFile}: missing bilingual pair`);
    continue;
  }
  const chinese = await readFile(chinesePath, "utf8");
  const english = await readFile(englishPath, "utf8");
  if (!chinese.split("\n").slice(0, 6).join("\n").includes(englishFile.split("/").at(-1))) {
    failures.push(`${chineseFile}: missing English language link`);
  }
  if (!english.split("\n").slice(0, 6).join("\n").includes(chineseFile.split("/").at(-1))) {
    failures.push(`${englishFile}: missing Chinese language link`);
  }
  if (count(chinese, /^#{1,6} /gm) !== count(english, /^#{1,6} /gm)) {
    failures.push(`${chineseFile}: bilingual heading count differs`);
  }
  if (count(chinese, /^```/gm) !== count(english, /^```/gm)) {
    failures.push(`${chineseFile}: bilingual code fence count differs`);
  }
}

const localLinkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of await markdownFiles(root)) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(localLinkPattern)) {
    const target = match[1].split("#")[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (!(await exists(resolve(dirname(file), target)))) {
      failures.push(
        `${file.slice(root.length + 1)}: missing link target ${target}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Documentation checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Documentation checks passed.");
