import cliProgress from "cli-progress"
import { puppeteerSg } from "../utils/request/PuppeteerSg.js";
import { pdfGenerator } from "../utils/io/PdfGenerator.js";
import { configLoader } from "../utils/io/ConfigLoader.js";
import { directoryIo } from "../utils/io/DirectoryIo.js"
import * as scribdRegex from "../const/ScribdRegex.js"
import * as scribdFlag  from '../const/ScribdFlag.js'
import { Image } from "../object/Image.js"
import sharp from "sharp";
import path from 'path'
import sanitize from "sanitize-filename";
import fs from "fs/promises";


async function nukePrivacyBanner(page) {
  // Try clicking first (handles A/B variants and locales)
  const clickers = [
    "//button[contains(., 'Accept')]",
    "//button[contains(., 'Aceitar')]",
    "//button[contains(., 'OK')]",
    "//button[contains(., 'Agree')]",
    "//button[contains(., 'Deny Non-Essential')]",
    "//button[contains(., 'Recusar')]",
  ];
  for (const xp of clickers) {
    try {
      const [btn] = await page.$x(xp);
      if (btn) { await btn.click({ delay: 30 }); await page.waitForTimeout(300); }
    } catch {}
  }

  // Brutal fallback: remove known containers and anything that *looks* like the banner
  await page.evaluate(() => {
    const kill = sel => document.querySelectorAll(sel).forEach(n => n.remove());
    kill('#onetrust-banner-sdk, #ot-sdk-container, .otFloatingBtn, .ot-sdk-container');
    kill('[data-testid="gdpr-banner"], [aria-label*="privacy" i], [role="dialog"][aria-modal="true"]');

    // Text-based sweep
    for (const el of Array.from(document.querySelectorAll('div,section,aside,footer'))) {
      const t = (el.innerText || '').toLowerCase();
      if (!t) continue;
      if (t.includes('privacy preferences') || t.includes('cookies')) {
        if (t.includes('accept') || t.includes('deny') || t.includes('non-essential')) el.remove();
      }
    }

    // Safety net: ensure any fixed overlays don’t print even if we missed them
    const css = document.createElement('style');
    css.textContent = `
      [style*="position: fixed"], .fixed, .sticky { display: none !important; }
    `;
    document.head.appendChild(css);
  });
}


function getCliFlag(name, fallback = null) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : fallback;
}

// "jpg" by default for lighter files
const imgfmt = (getCliFlag("imgfmt", "jpg") || "jpg").toLowerCase(); // "jpg" | "png"
const isPNG = imgfmt === "png";

// NEW: scale override
const cfgScale = parseFloat(configLoader.load("SCRIBD", "scale") || "2");
const cliScale = parseFloat(getCliFlag("scale", ""));
const baseScale = Number.isFinite(cliScale)
  ? cliScale
  : (Number.isFinite(cfgScale) ? cfgScale : 2);
  
function parsePagesSpec(spec, total) {
  if (!spec) return null;            // full doc
  const parts = spec.replace(/,/g, ";").split(/[\s;]+/).filter(Boolean);
  const set = new Set();
  for (const p of parts) {
    const m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    a = Math.max(1, a);
    if (total) b = Math.min(total, b);
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set.size ? set : null;      // Set of 1-based pages, or null for full
}

// NEW: JPEG quality override (50–95 recommended)
const cfgJpgQ = parseInt(configLoader.load("SCRIBD", "jpgq") || "");
const cliJpgQ = parseInt(getCliFlag("jpgq", ""));
let jpgQuality = Number.isFinite(cliJpgQ)
  ? cliJpgQ
  : (Number.isFinite(cfgJpgQ) ? cfgJpgQ : 85);
jpgQuality = Math.min(95, Math.max(50, jpgQuality));

//const output = configLoader.load("DIRECTORY", "output")
//const filename = configLoader.load("DIRECTORY", "filename")

// Allow CLI to override config.ini values
const cliOutput   = getCliFlag("output", null);
const cliFilename = getCliFlag("filename", null);

const output   = (cliOutput && cliOutput.trim().length)
  ? cliOutput
  : configLoader.load("DIRECTORY", "output");

const filename = (cliFilename && cliFilename.trim().length)
  ? cliFilename
  : configLoader.load("DIRECTORY", "filename");

const rendertime = parseInt(configLoader.load("SCRIBD", "rendertime"))
const PLAIN = !process.stdout.isTTY; // non-TTY (like QProcess) needs plain logs
const scaleCfg = parseFloat(configLoader.load("SCRIBD", "scale") || "2");
//const deviceScaleDefault = Number.isFinite(scaleCfg) && scaleCfg > 0 ? scaleCfg : 2;
const deviceScaleDefault = baseScale;



class ScribdDownloader {
    constructor() {
        if (!ScribdDownloader.instance) {
            ScribdDownloader.instance = this
        }
        return ScribdDownloader.instance
    }

    async execute(url, flag, pagesSpec) {
        let fn;
        if (flag === scribdFlag.IMAGE) {
            console.log(`Mode: IMAGE`)
            fn = this.embeds_image
        } else {
            console.log(`Mode: DEFAULT`)
            fn = this.embeds_default
        }
        if (url.match(scribdRegex.DOCUMENT)) {
            await fn(`https://www.scribd.com/embeds/${scribdRegex.DOCUMENT.exec(url)[2]}/content`, pagesSpec)
        } else if (url.match(scribdRegex.EMBED)) {
            await fn(url, pagesSpec)
        } else {
            throw new Error(`Unsupported URL: ${url}`)
        }
    }

    async embeds_default(url, pagesSpec) {
        const m = scribdRegex.EMBED.exec(url)
        if (m) {
            let id = m[1]

            // navigate to scribd
            let page = await puppeteerSg.getPage(url)

            // wait rendering
            await new Promise(resolve => setTimeout(resolve, 1000))

            await nukePrivacyBanner(page);

            // get the title
            let div = await page.$("div.mobile_overlay a")
            let title = decodeURIComponent(await div.evaluate((el) => el.href.split('/').pop().trim()))

            // load all pages (robust lazy-load loop)
            await page.click('div.document_scroller');
            const container = await page.$('div.document_scroller');

            // progress: we don't know final height; just show a 2-step bar (loading -> done)
            const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
            bar.start(2, 0);

            // **Instead of relying only on scrollHeight “stable” check, force every page into view**
            let doc_pages = await page.$$("div.outer_page_container div[id^='outer_page_']");


            // PAGE RANGE for DEFAULT: parse, then LOAD first, PRUNE later
            const total = doc_pages.length;
            const allowedSet = parsePagesSpec(pagesSpec, total); // Set(1-based) or null
            let filenameSuffix = "";
            let needList = null;

            if (allowedSet && allowedSet.size) {
            needList = [...allowedSet].sort((a,b)=>a-b);
            filenameSuffix = "-partial";

            // 1) Force-load each needed page by original ID without deleting anything yet
            const stepWait = Math.max(150, Math.min(rendertime || 400, 600));
            for (const n of needList) {
                await page.evaluate((num) => {
                const el = document.getElementById(`outer_page_${num}`);
                if (el) el.scrollIntoView();
                }, n);
                await new Promise(r => setTimeout(r, stepWait));

                // 2) Wait until the page has real content (img/canvas/svg or background-image)
                await page.waitForFunction((num) => {
                const el = document.getElementById(`outer_page_${num}`);
                if (!el) return false;
                if (el.querySelector('img, canvas, svg, picture')) return true;
                const s = getComputedStyle(el);
                return s.backgroundImage && s.backgroundImage !== 'none';
                }, { timeout: 15000 }, n).catch(() => {}); // don’t crash; worst case we still print
            }

            // 3) Now prune unselected pages so Chromium only prints the kept ones
            await page.evaluate((kept) => {
                const keep = new Set(kept);
                const nodes = Array.from(document.querySelectorAll('div.outer_page_container div[id^="outer_page_"]'));
                nodes.forEach((pg, idx) => {
                const n = idx + 1; // 1-based in Scribd’s order
                if (!keep.has(n)) pg.remove();
                });
            }, needList);

            // Re-query after pruning so subsequent code touches only kept pages
            doc_pages = await page.$$("div.outer_page_container div[id^='outer_page_']");
            }


            const stepWait = Math.max(150, Math.min(rendertime || 400, 600));

            for (let i = 0; i < doc_pages.length; i++) {
            // Scroll the actual element we kept, not a guessed ID
            await doc_pages[i].evaluate(el => el.scrollIntoView());
            await new Promise(r => setTimeout(r, stepWait));
            }

            // sanity nudge: make sure final page is actually in view
            await container.evaluate(el => el.scrollTo(0, el.scrollHeight));

            bar.update(1);
            bar.update(2);
            bar.stop();

            // remove margin to avoid extra blank page
            for (let i = 0; i < doc_pages.length; i++) {
            await doc_pages[i].evaluate(el => { el.style.margin = '0'; });
            }

            await nukePrivacyBanner(page);

            // pdf setting + sane sizing
            // Limit the printed output to the exact number of loaded Scribd pages
            const realPages = Math.max(1, (await page.$$eval('div.outer_page_container div[id^="outer_page_"]', els => els.length)) || 1);

            let options = {
            path: `${output}/${sanitize((filename == "title" ? title : id) + filenameSuffix)}.pdf`,
            printBackground: true,
            preferCSSPageSize: true,
            timeout: 0,
            margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
            pageRanges: `1-${realPages}`
            };


            const first_page = await page.$("div.outer_page_container div[id^='outer_page_']");
            const style = await first_page?.evaluate(el => el.getAttribute("style") || "");
            if (style.includes("width:") && style.includes("height:")) {
            const h = parseInt(style.split("height:")[1].split("px")[0].trim(), 10);
            const w = parseInt(style.split("width:")[1].split("px")[0].trim(), 10);
            if (Number.isFinite(h) && Number.isFinite(w)) {
                options.height = `${h}px`;   // use px units
                options.width  = `${w}px`;
            }
            }

            // show only the doc markup but keep <head> intact
            await page.evaluate(() => {
            const body = document.body;
            const container = document.querySelector("div.outer_page_container");
            if (container) body.innerHTML = container.innerHTML;
            });
            

            // calm the page down so Chromium doesn't stall
            await page.addStyleTag({ content: `
            * { animation: none !important; transition: none !important; }
            [style*="position: fixed"] { position: static !important; }
            `});

            // Force each Scribd page to crop anything that bleeds outside its bounds
            await page.addStyleTag({ content: `
            [id^="outer_page_"] {
                overflow: hidden !important;
                max-height: 100% !important;
                box-sizing: border-box !important;
            }
            html, body {
                margin: 0 !important;
                padding: 0 !important;
            }
            @page {
                margin: 0;
                size: auto;
            }
            `});


            await page.emulateMediaType('screen');
            await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {});
            await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
            // double rAF to let layout settle
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

            await directoryIo.create(path.dirname(options.path));

            // tell the Qt dialog what to expect
            if (PLAIN) console.log(`[TOTAL] ${realPages}`);

            // print with a guard (optional but kind)
            const print = page.pdf(options);
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('pdf-timeout')), 120000));
            await Promise.race([print, timeout]);

            if (PLAIN) console.log(`[PROGRESS] 1/1`);
            console.log(`Generated: ${options.path}`);

            await page.close()
            await puppeteerSg.close()

            // after await puppeteerSg.close()
            if (PLAIN) console.log('[DONE]');
            process.exit(0);
        } else {
            throw new Error(`Unsupported URL: ${url}`)
        }
    }

    async embeds_image(url, pagesSpec) {
    // scale comes from config: const deviceScaleDefault = ...
    let deviceScaleFactor = deviceScaleDefault;

    const m = scribdRegex.EMBED.exec(url);
    if (!m) throw new Error(`Unsupported URL: ${url}`);
    const id = m[1];

    // 1) temp dir for page images
    const dir = `${output}/${id}`;
    await directoryIo.create(dir);

    // 2) open page
    const page = await puppeteerSg.getPage(url);

    // 3) tiny settle wait
    await new Promise(r => setTimeout(r, 1000));

    //await nukePrivacyBanner(page); //optional to unify removing cookies

    // 4) remove/hide cookie banners
    await page.addStyleTag({
        content: `
        #onetrust-banner-sdk, .onetrust-pc-dark-filter, .ot-sdk-container,
        .ot-sdk-row, .ot-floating-button, .ot-pc-footer,
        [id*="cookie"], [class*="cookie"], [data-e2e*="cookie"],
        [aria-label*="cookie"], [aria-label*="Consent"] {
            display:none !important; visibility:hidden !important; pointer-events:none !important;
        }
        `
    });
    await page.evaluate(() => {
        const kill = sel => document.querySelectorAll(sel).forEach(e => e.remove());
        kill('#onetrust-banner-sdk, .onetrust-pc-dark-filter, .ot-sdk-container, .ot-sdk-row, .ot-floating-button, .ot-pc-footer');
        kill('[id*="cookie"], [class*="cookie"], [data-e2e*="cookie"], [aria-label*="cookie"], [aria-label*="Consent"]');
        document.querySelectorAll('div,section').forEach(e => {
        const s = getComputedStyle(e);
        if (s.position === 'fixed' && parseInt(s.bottom || '0') < 60 && parseInt(s.height || '0') > 40 &&
            (e.innerText || '').match(/cookie|consent|privacy/i)) e.remove();
        });
    });

    // 5) title for final filename
    const div = await page.$("div.mobile_overlay a");
    const title = decodeURIComponent(await div.evaluate(el => el.href.split('/').pop().trim()));

    // 6) hide built-in UI chrome
    const doc_container = await page.$("div.document_scroller");
    await doc_container.evaluate(el => {
        el.style.bottom = "0px";
        el.style.marginTop = "0px";
    });
    const doc_toolbar = await page.$("div.toolbar_drop");
    await doc_toolbar.evaluate(el => (el.style.display = "none"));

    // 7) discover pages
    const doc_pages = await page.$$("div.outer_page_container div[id^='outer_page_']");
    const total = doc_pages.length;

    // we already have: const total = doc_pages.length;
    const images = [];

    // 1) figure out which pages to capture
    const allowed = parsePagesSpec(pagesSpec, total);  // Set of 1-based pages, or null for full doc
    const needList = allowed
    ? [...allowed].sort((a,b)=>a-b)
    : Array.from({length: total}, (_,i)=>i+1);
    const selectedTotal = needList.length;

    // 2) discover existing images in temp dir
    const names = await fs.readdir(dir).catch(() => []);
    const existing = names
    .filter(n => /^\d{4}\.(?:jpg|jpeg|png)$/i.test(n))
    .sort();

    // 3) preload resume
    if (!allowed) {
    // full doc: contiguous prefix resume
    let resumeCount = existing.length;
    while (
        resumeCount > 0 &&
        !existing.includes(`${String(resumeCount).padStart(4,"0")}.jpg`) &&
        !existing.includes(`${String(resumeCount).padStart(4,"0")}.jpeg`) &&
        !existing.includes(`${String(resumeCount).padStart(4,"0")}.png`)
    ) {
        resumeCount--;
    }
    for (let i = 0; i < resumeCount; i++) {
        const base = `${String(i + 1).padStart(4,"0")}`;
        const ext  = existing.find(n => n.startsWith(base + "."))?.split(".").pop();
        const p    = `${dir}/${base}.${ext}`;
        const meta = await sharp(p).metadata();
        images.push(new Image(p, meta.width, meta.height));
    }
    } else {
    // range mode: preload whatever selected pages already exist
    for (const n of needList) {
        const base = `${String(n).padStart(4,"0")}`;
        const ext  = existing.find(x => x.startsWith(base + "."))?.split(".").pop();
        if (!ext) continue;
        const p    = `${dir}/${base}.${ext}`;
        const meta = await sharp(p).metadata();
        images.push(new Image(p, meta.width, meta.height));
    }
    }

    // 4) start progress with selectedTotal and preloaded count
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    if (PLAIN) {
    console.log(`[TOTAL] ${selectedTotal}`);
    if (images.length > 0) console.log(`[PROGRESS] ${images.length}/${selectedTotal}`);
    }
    bar.start(selectedTotal, images.length);


    // capture only the pages we need (respects range or full)
    for (const pageNum of needList) {
    const i    = pageNum - 1;
    const base = `${String(pageNum).padStart(4,"0")}`;

    // skip if already present from resume/preload
    if (existing.some(n => n.startsWith(base + "."))) continue;

    // re-kill any banner that respawned
    await page.evaluate(() => {
        const kill = sel => document.querySelectorAll(sel).forEach(e => e.remove());
        kill('#onetrust-banner-sdk, .onetrust-pc-dark-filter, .ot-sdk-container, .ot-sdk-row, .ot-floating-button, .ot-pc-footer');
        kill('[id*="cookie"], [class*="cookie"], [data-e2e*="cookie"], [aria-label*="cookie"], [aria-label*="Consent"]');
    });

    // scroll target into view
    await page.evaluate(j => document.getElementById(`outer_page_${j + 1}`).scrollIntoView(), i);

    // viewport sizing
    let width = 1191, height = 1684;
    const style = await doc_pages[i].evaluate(el => el.getAttribute("style"));
    if (style?.includes("width:") && style.includes("height:")) {
        const h = parseInt(style.split("height:")[1].split("px")[0].trim());
        const w = parseInt(style.split("width:")[1].split("px")[0].trim());
        height = Math.ceil(width * h / w);
    }
    await page.setViewport({ width, height, deviceScaleFactor });

    // screenshot to PNG, then convert to JPG (your current code); or keep PNG if you reverted that

    const pngPath = `${dir}/${base}.png`;
    await doc_pages[i].screenshot({ path: pngPath });

    const imgfmt = (process.argv.find(a => a.startsWith("--imgfmt="))?.split("=")[1] || "jpg").toLowerCase();
    const isPNG = imgfmt === "png";

    // If PNG mode, just keep the screenshot as-is.
    // If JPG mode, re-encode and delete the temporary PNG.
    const outPath = isPNG ? pngPath : `${dir}/${base}.jpg`;
    if (!isPNG) {
    await sharp(pngPath)
        .jpeg({ quality: jpgQuality, mozjpeg: true, chromaSubsampling: "4:4:4", progressive: true })
        .toFile(outPath);
    await fs.unlink(pngPath);
    }
    if (PLAIN && !isPNG) console.log(`[JPGQ] ${jpgQuality}`);

    // 3) Push the image we actually wrote
    const meta = await sharp(outPath).metadata();
    images.push(new Image(outPath, meta.width, meta.height));

    bar.update(images.length);
    if (PLAIN) console.log(`[PROGRESS] ${images.length}/${selectedTotal}`);
    }
    bar.stop();


    // verify that every selected page exists
    const selectedBases = needList.map(n => String(n).padStart(4,"0"));
    const hasAll = await Promise.all(selectedBases.map(async b => {
      const stats = await Promise.all([
        fs.stat(`${dir}/${b}.jpg`).catch(()=>null),
        fs.stat(`${dir}/${b}.jpeg`).catch(()=>null),
        fs.stat(`${dir}/${b}.png`).catch(()=>null),
      ]);
      return stats.some(s => s && s.size > 0);
    }));
    const completed = hasAll.every(Boolean);

    // filename suffix if partial selection
    const suffix = allowed ? "-partial" : "";

    try {
      await pdfGenerator.generate(
        images,
        `${output}/${sanitize((filename == "title" ? title : id) + suffix)}.pdf`
      );
    // delete temp only for full-doc runs that finished 100%
    if (completed) {
      if (PLAIN) console.log(`[CLEANUP] removed ${dir}`);
      await directoryIo.remove(`${dir}`);
    } else {
      if (PLAIN) console.log(`[RESUME] kept temp pages in ${dir}`);
    }
    } finally {
    await page.close();
    await puppeteerSg.close();
    }
    }
}
export const scribdDownloader = new ScribdDownloader()
