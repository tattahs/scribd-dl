import { app } from "./src/App.js";
import * as scribdFlag from "./src/const/ScribdFlag.js";

console.log("RUN ARGS:", process.argv.slice(2).join(" | "));

const flags = [scribdFlag.DEFAULT, scribdFlag.IMAGE];

const argv = process.argv.slice(2);

// pick out pieces
let url = "";
let flag = undefined;
let pagesSpec = "";

// url is the first arg that is NOT a flag (/i) and NOT an option (--something)
for (const a of argv) {
  if (flags.includes(a)) {
    flag = a;
  } else if (a.startsWith("--pages=")) {
    pagesSpec = a.split("=").slice(1).join("="); // keeps anything after the first '='
  } else if (!url) {
    url = a;
  }
}

if (url) {
  await app.execute(url, flag, pagesSpec);
} else {
  console.error(`
Usage: npm start [options] <url>

Options:
  /i                  image-based capture (recommended)
  --pages="spec"      page selection, e.g. --pages="5-15" or --pages="2; 6; 38"
Examples:
  npm start /i "https://www.scribd.com/document/12345"
  npm start /i --pages="5-15" "https://www.scribd.com/document/12345"
`);
}
