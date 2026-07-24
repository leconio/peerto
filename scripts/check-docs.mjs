import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const pairs = [
  ["README.md", "README.zh-CN.md"],
  ["ARCHITECTURE.md", "ARCHITECTURE.zh-CN.md"],
  ["CHANGELOG.md", "CHANGELOG.zh-CN.md"],
  ["CODE_OF_CONDUCT.md", "CODE_OF_CONDUCT.zh-CN.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md"],
  ["REQUIREMENTS.md", "REQUIREMENTS.zh-CN.md"],
  ["SECURITY.md", "SECURITY.zh-CN.md"],
  ["docs/cloudflare.md", "docs/cloudflare.zh-CN.md"],
  ["docs/deployment.md", "docs/deployment.zh-CN.md"],
  ["docs/privacy.md", "docs/privacy.zh-CN.md"],
  ["docs/troubleshooting.md", "docs/troubleshooting.zh-CN.md"],
  ["docs/turn.md", "docs/turn.zh-CN.md"],
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

for (const [englishFile, chineseFile] of pairs) {
  const englishPath = join(root, englishFile);
  const chinesePath = join(root, chineseFile);
  if (!(await exists(englishPath)) || !(await exists(chinesePath))) {
    failures.push(`${englishFile}: missing bilingual pair`);
    continue;
  }
  const english = await readFile(englishPath, "utf8");
  const chinese = await readFile(chinesePath, "utf8");
  if (!english.split("\n").slice(0, 6).join("\n").includes(chineseFile.split("/").at(-1))) {
    failures.push(`${englishFile}: missing Chinese language link`);
  }
  if (!chinese.split("\n").slice(0, 6).join("\n").includes(englishFile.split("/").at(-1))) {
    failures.push(`${chineseFile}: missing English language link`);
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
