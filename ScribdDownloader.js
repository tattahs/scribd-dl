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


const output = configLoader.load("DIRECTORY", "output")
const filename = configLoader.load("DIRECTORY", "filename")
const rendertime = parseInt(configLoader.load("SCRIBD", "rendertime"))
const PLAIN = !process.stdout.isTTY; // non-TTY (like QProcess) needs plain logs
const scaleCfg = parseFloat(configLoader.load("SCRIBD", "scale") || "2");
const deviceScaleDefault = Number.isFinite(scaleCfg) && scaleCfg > 0 ? scaleCfg : 2;

class ScribdDownloader {
    constructor() {
        if (!ScribdDownloader.instance) {
            ScribdDownloader.instance = this
        }
        return ScribdDownloader.instance
    }

    async execute(url, flag) {
        let fn;
        if (flag === scribdFlag.IMAGE) {
            console.log(`Mode: IMAGE`)
            fn = this.embeds_image
        } else {
            console.log(`Mode: DEFAULT`)
            fn = this.embeds_default
        }
        if (url.match(scribdRegex.DOCUMENT)) {
            await fn(`https://www.scribd.com/embeds/${scribdRegex.DOCUMENT.exec(url)[2]}/content`)
        } else if (url.match(scribdRegex.EMBED)) {
            await fn(url)
        } else {
            throw new Error(`Unsupported URL: ${url}`)
        }
    }

    async embeds_default(url) {
        const m = scribdRegex.EMBED.exec(url)
        if (m) {
            let id = m[1]

            // navigate to scribd
            let page = await puppeteerSg.getPage(url)

            // wait rendering
            await new Promise(resolve => setTimeout(resolve, 1000))

            // get the title
            let div = await page.$("div.mobile_overlay a")
            let title = decodeURIComponent(await div.evaluate((el) => el.href.split('/').pop().trim()))

            // load all pages
            await page.click('div.document_scroller');
            const container = await page.$('div.document_scroller');
            const height = await container.evaluate(el => el.scrollHeight);
            const clientHeight = await container.evaluate(el => el.clientHeight);
            let cur = await container.evaluate(el => el.scrollTop);
            const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
            bar.start(height, 0);
            while (cur + clientHeight < height) {
                await page.keyboard.press('PageDown');
                await new Promise(resolve => setTimeout(resolve, rendertime))
                cur = await container.evaluate(el => el.scrollTop);
                bar.update(cur + clientHeight);
            }
            bar.stop();

            // remove margin to avoid extra blank page
            let doc_pages = await page.$$("div.outer_page_container div[id^='outer_page_']")
            for (let i = 0; i < doc_pages.length; i++) {
                await page.evaluate((i) => {
                    document.getElementById(`outer_page_${(i + 1)}`).style.margin = 0
                }, i)
            }

            // pdf setting
            let options = {
                path: `${output}/${sanitize(filename == "title" ? title : id)}.pdf`,
                printBackground: true,
                timeout: 0
            }
            let first_page = await page.$("div.outer_page_container div[id^='outer_page_']")
            let style = await first_page.evaluate((el) => el.getAttribute("style"))
            if (style.includes("width:") && style.includes("height:")) {
                options.height = parseInt(style.split("height:")[1].split("px")[0].trim())
                options.width = parseInt(style.split("width:")[1].split("px")[0].trim())
            }

            // show doc only
            await page.evaluate(() => { // eslint-disable-next-line
                document.body.innerHTML = document.querySelector("div.outer_page_container").innerHTML
            })
            
            await directoryIo.create(path.dirname(options.path))
            await page.pdf(options);
            console.log(`Generated: ${options.path}`)

            await page.close()
            await puppeteerSg.close()
        } else {
            throw new Error(`Unsupported URL: ${url}`)
        }
    }

    async embeds_image(url) {
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
    const images = [];

    // --- RESUME SUPPORT: preload existing images and continue ---
    // consider files named 0001.jpg / 0001.png etc.
    const names = await fs.readdir(dir);
    const existing = names
        .filter(n => /^\d{4}\.(?:jpg|jpeg|png)$/i.test(n))
        .sort(); // lexicographic is fine for 0001… format
    let resumeCount = existing.length;

    // sanity: if files are not contiguous (missing last), only use the contiguous prefix
    while (resumeCount > 0 && !existing.includes(`${String(resumeCount).padStart(4, "0")}.jpg`) &&
            !existing.includes(`${String(resumeCount).padStart(4, "0")}.jpeg`) &&
            !existing.includes(`${String(resumeCount).padStart(4, "0")}.png`)) {
        resumeCount--;
    }

    // preload Image objects for existing pages
    for (let i = 0; i < resumeCount; i++) {
        const base = `${String(i + 1).padStart(4, "0")}`;
        const ext = existing.find(n => n.startsWith(base + "."))?.split(".").pop();
        const p = `${dir}/${base}.${ext}`;
        const meta = await sharp(p).metadata();
        images.push(new Image(p, meta.width, meta.height));
    }

    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    if (PLAIN) {
        console.log(`[TOTAL] ${total}`);
        if (resumeCount > 0) console.log(`[PROGRESS] ${resumeCount}/${total}`);
    }

    bar.start(total, resumeCount);

    // 8) capture missing pages only
    for (let i = resumeCount; i < total; i++) {
        // re-kill any banner that respawned
        await page.evaluate(() => {
        const kill = sel => document.querySelectorAll(sel).forEach(e => e.remove());
        kill('#onetrust-banner-sdk, .onetrust-pc-dark-filter, .ot-sdk-container, .ot-sdk-row, .ot-floating-button, .ot-pc-footer');
        kill('[id*="cookie"], [class*="cookie"], [data-e2e*="cookie"], [aria-label*="cookie"], [aria-label*="Consent"]');
        });

        // scroll target into view
        await page.evaluate(j => document.getElementById(`outer_page_${j + 1}`).scrollIntoView(), i);

        // viewport: keep consistent aspect
        let width = 1191;
        let height = 1684;
        const style = await doc_pages[i].evaluate(el => el.getAttribute("style"));
        if (style?.includes("width:") && style.includes("height:")) {
        const h = parseInt(style.split("height:")[1].split("px")[0].trim());
        const w = parseInt(style.split("width:")[1].split("px")[0].trim());
        height = Math.ceil(width * h / w);
        }
        await page.setViewport({ width, height, deviceScaleFactor });

        // screenshot to PNG, convert to JPG to shrink, delete PNG
        const idx = (i + 1).toString().padStart(4, "0");
        const pngPath = `${dir}/${idx}.png`;
        await doc_pages[i].screenshot({ path: pngPath });

        const jpgPath = `${dir}/${idx}.jpg`;
        await sharp(pngPath)
        .jpeg({ quality: 68, mozjpeg: true, chromaSubsampling: "4:2:0", progressive: true })
        .toFile(jpgPath);
        await fs.unlink(pngPath);

        const meta = await sharp(jpgPath).metadata();
        images.push(new Image(jpgPath, meta.width, meta.height));

        bar.update(i + 1);
        if (PLAIN) console.log(`[PROGRESS] ${i + 1}/${total}`);
    }

    bar.stop();

    //const completed = (images.length === total);  // we have every page (preloaded + new)

    // verify all pages 0001..NNNN exist as jpg/jpeg/png
    const pageBases = Array.from({length: total}, (_, i) => String(i+1).padStart(4,"0"));
    const hasAll = await Promise.all(pageBases.map(async b => {
    try {
        const stats = await Promise.all([
        fs.stat(`${dir}/${b}.jpg`).catch(()=>null),
        fs.stat(`${dir}/${b}.jpeg`).catch(()=>null),
        fs.stat(`${dir}/${b}.png`).catch(()=>null),
        ]);
        return stats.some(s => s && s.size > 0);
    } catch { return false; }
    }));
    const completed = hasAll.every(Boolean);


    // 9) build PDF and conditional cleanup
    try {
    await pdfGenerator.generate(
        images,
        `${output}/${sanitize(filename == "title" ? title : id)}.pdf`
    );
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
