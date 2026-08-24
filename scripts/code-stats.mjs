import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { tokei } from "@kitschpatrol/tokei";

const SOURCE_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".prisma",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
]);

const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "apps",
    "packages",
    "scripts",
  ],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((file) => file && SOURCE_EXTENSIONS.has(extname(file)));

const prismaFiles = files.filter((file) => extname(file) === ".prisma");
const statistics = await tokei({
  include: files.filter((file) => extname(file) !== ".prisma"),
});

const rows = statistics.map(
  ({ language, files, lines, code, comments, blanks }) => ({
    language,
    files,
    lines,
    code,
    comments,
    blanks,
  }),
);

if (prismaFiles.length > 0) {
  const prisma = {
    language: "Prisma",
    files: prismaFiles.length,
    lines: 0,
    code: 0,
    comments: 0,
    blanks: 0,
  };

  for (const file of prismaFiles) {
    const fileLines = (await readFile(file, "utf8")).split(/\r\n|\r|\n/);
    if (fileLines.at(-1) === "") fileLines.pop();

    for (const line of fileLines) {
      prisma.lines += 1;
      if (line.trim() === "") prisma.blanks += 1;
      else if (line.trimStart().startsWith("//")) prisma.comments += 1;
      else prisma.code += 1;
    }
  }

  rows.push(prisma);
}

rows.sort((left, right) => left.language.localeCompare(right.language));

const total = rows.reduce(
  (sum, row) => ({
    language: "Total",
    files: sum.files + row.files,
    lines: sum.lines + row.lines,
    code: sum.code + row.code,
    comments: sum.comments + row.comments,
    blanks: sum.blanks + row.blanks,
  }),
  { language: "Total", files: 0, lines: 0, code: 0, comments: 0, blanks: 0 },
);

console.table([...rows, total]);
