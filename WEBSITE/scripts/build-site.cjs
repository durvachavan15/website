const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const pages = ["index.html", "booking.html", "confirm.html", "payment.html", "account.html"];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const page of pages) fs.copyFileSync(path.join(root, page), path.join(output, page));
for (const directory of ["css", "images", "js"]) {
  fs.cpSync(path.join(root, directory), path.join(output, directory), { recursive: true });
}
console.log("Static site copied to dist/.");