const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const outputDir = path.join(rootDir, "dist", "crazygames");
const apiBaseUrl = String(process.env.LOCGUSSER_API_BASE_URL || "https://YOUR-BACKEND-HOST").replace(/\/+$/, "");

fs.rmSync(outputDir, { recursive: true, force: true });
copyDirectory(publicDir, outputDir);

fs.writeFileSync(
  path.join(outputDir, "runtime-config.js"),
  [
    `window.LOCGUSSER_API_BASE_URL = ${JSON.stringify(apiBaseUrl)};`,
    "window.LOCGUSSER_CRAZYGAMES = true;",
    ""
  ].join("\n")
);

fs.writeFileSync(
  path.join(outputDir, "README-UPLOAD.txt"),
  [
    "Upload this folder as the CrazyGames HTML5 build.",
    "",
    "Before uploading, set LOCGUSSER_API_BASE_URL to your deployed HTTPS backend:",
    "LOCGUSSER_API_BASE_URL=https://your-api.example.com npm run build:crazygames",
    "",
    "Do not upload this placeholder build until runtime-config.js points to the real backend."
  ].join("\n")
);

console.log(`CrazyGames build written to ${path.relative(rootDir, outputDir)}`);
console.log(`API backend: ${apiBaseUrl}`);

function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}
