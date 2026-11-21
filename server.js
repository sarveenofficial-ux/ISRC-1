// Song ISRC Finder backend: Express + Playwright
// Setup: npm init -y && npm i express cors playwright && npx playwright install --with-deps chromium
// Run:   node server.js   (serves index.html too, so one deployment is enough)
const express = require("express");
const cors = require("cors");
const path = require("path");
const { chromium } = require("playwright");

const SOURCE = "https://www.isrcfinder.com/";
const TRACK = /^https:\/\/open\.spotify\.com\/(intl-[a-z]{2,}\/)?track\/[A-Za-z0-9]{22}$/i;
const ISRC_RE = /\b[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}\b/g;
const SEARCH_TIMEOUT = 45000;

const app = express();
app.use(cors()); // restrict to your GitHub Pages origin in production
app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

let browser;
let active = 0; // keep load low: one search at a time per instance
async function getBrowser() {
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  return browser;
}

const fail = (res, code, status = 200) => res.status(status).json({ ok: false, code });

app.post("/api/isrc", async (req, res) => {
  const url = String((req.body && req.body.url) || "").trim();
  if (!TRACK.test(url)) return fail(res, "INVALID_URL", 400);
  if (active >= 1) return fail(res, "SITE_UNAVAILABLE", 429);
  active++;
  let ctx;
  try {
    ctx = await (await getBrowser()).newContext({ locale: "en-US" });
    const page = await ctx.newPage();
    page.setDefaultTimeout(SEARCH_TIMEOUT);

    try {
      const resp = await page.goto(SOURCE, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (!resp || resp.status() >= 400) return fail(res, "SITE_UNAVAILABLE");
    } catch (e) { return fail(res, "SITE_UNAVAILABLE"); }

    // Respect access controls: if a human check shows up, stop (never bypass).
    const html = (await page.content()).toLowerCase();
    if (/captcha|cf-challenge|just a moment|verify you are human/.test(html)) return fail(res, "SITE_UNAVAILABLE");

    // NOTE: selectors are generic; adjust after inspecting the live page if needed.
    const input = page.locator('input[type="text"], input[type="search"], input[type="url"], input:not([type])').first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    const before = (await page.innerText("body")).match(ISRC_RE) || [];
    await input.fill(url);
    await page.getByRole("button", { name: /find isrc/i }).first().click();

    // Wait for a new ISRC, or a recognizable "no result" message.
    const known = JSON.stringify(before);
    await page.waitForFunction(([re, known]) => {
      const t = document.body.innerText;
      const found = (t.match(new RegExp(re, "g")) || []).filter(x => !JSON.parse(known).includes(x));
      return found.length > 0 || /not found|no results?|couldn.?t find|no isrc|invalid|error/i.test(t.split("About")[0]);
    }, [ISRC_RE.source, known], { timeout: SEARCH_TIMEOUT });

    const text = await page.innerText("body");
    const top = text.split(/\nAbout\n|What.s an ISRC/)[0];
    const lines = top.split("\n").map(s => s.trim()).filter(Boolean);
    const matches = [];
    lines.forEach((ln, i) => {
      (ln.match(ISRC_RE) || []).forEach(code => {
        if (!before.includes(code) && !matches.some(m => m.isrc === code)) {
          const ctxLines = lines.slice(Math.max(0, i - 3), i).filter(l => !ISRC_RE.test(l) && !/^(find isrc|isrc|copy)/i.test(l));
          matches.push({ isrc: code, song: ctxLines[ctxLines.length - 2] || ctxLines[ctxLines.length - 1] || "", artist: ctxLines.length > 1 ? ctxLines[ctxLines.length - 1] : "" });
        }
      });
    });

    if (matches.length === 1) {
      const m = matches[0];
      return res.json({ ok: true, isrc: m.isrc, song: m.song || undefined, artist: m.artist || undefined });
    }
    if (matches.length > 1) return res.json({ ok: false, code: "MULTIPLE", matches: matches.map(m => ({ isrc: m.isrc, label: [m.song, m.artist].filter(Boolean).join(" – ") })) });
    if (/no isrc/i.test(top)) return fail(res, "NO_ISRC");
    return fail(res, "NOT_FOUND");
  } catch (e) {
    return fail(res, /timeout/i.test(String(e)) ? "TIMEOUT" : "SITE_UNAVAILABLE");
  } finally {
    active--;
    if (ctx) await ctx.close().catch(() => {});
  }
});

app.get("/health", (_, r) => r.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Song ISRC Finder running on :" + PORT));
