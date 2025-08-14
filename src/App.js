import { scribdDownloader } from "./service/ScribdDownloader.js";
import { slideshareDownloader } from "./service/SlideshareDownloader.js";
import { everandDownloader } from "./service/EverandDownloader.js";
import * as scribdRegex from "./const/ScribdRegex.js";
import * as slideshareRegex from "./const/SlideshareRegex.js";
import * as everandRegex from "./const/EverandRegex.js";

// normalize helper (yours)
function normalizeScribdUrl(raw) {
  const u = new URL(raw);
  if (/^[a-z]{2}$/i.test(u.hostname.split(".")[0]) || u.hostname.startsWith("m.")) {
    u.hostname = "www.scribd.com";
  }
  if (u.pathname.startsWith("/doc/")) {
    u.pathname = u.pathname.replace("/doc/", "/document/");
  }
  return u.toString();
}

class App {
  constructor() {
    if (!App.instance) App.instance = this;
    return App.instance;
  }

  async execute(url, flag, pagesSpec = "") {
    console.log("APP.execute pagesSpec=", pagesSpec || "(none)");
    url = normalizeScribdUrl(url);

    if (url.match(scribdRegex.DOMAIN)) {
      await scribdDownloader.execute(url, flag, pagesSpec);   // ← pass it
    } else if (url.match(slideshareRegex.DOMAIN)) {
      await slideshareDownloader.execute(url);
    } else if (url.match(everandRegex.DOMAIN)) {
      await everandDownloader.execute(url);
    } else {
      throw new Error(`Unsupported URL: ${url}`);
    }
  }
}

export const app = new App();
