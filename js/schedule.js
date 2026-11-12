// ヘルパー稼働表（組合が公開しているGoogleスプレッドシート）から、日ごとに何名まで頼めるかを読み取る。
//
//  既存の管理統合システムの kanri/helper/schedule.py をそのまま移したもの。
//  スプレッドシートは年度ごと（R8年度稼働 など）で、月ごとのシート（「10月稼動」など）が並ぶ。
//  1枚が上旬（1〜16日）と下旬（17〜31日）の2列、それぞれ8日ずつ2段に分かれ、1日＝5列（1列＝1利用者）で
//    日 / 曜日 / 利用者名 / 地区 / ヘルパーNo / 稼働数 / 区分 / 休日（＋その下に「有給」「希望」など）
//  の行が並ぶ。
//
//  頼める人数（空き）の決め方:
//    1. 「ヘルパーNo」の行に組合が書いた言葉があればそれに従う（「2名受入可」→2、「満度です」「全休」→0）
//    2. 無ければ 専任ヘルパーの人数 − 稼働数の合計 − 休日の印（①②… と ★）の数
//  利用者も休日も何も入っていない月は、まだ作られていないとみなして空きを出さない。
//
//  組合の稼働表一覧（Notion）はスマホのブラウザから直接読めないため、
//  スプレッドシートの場所は DEFAULT_SHEETS と、公開場所の sheets.json と、設定で足したURLから集める。

import { CIRCLED, norm, nameKey, parseCsv, daysInMonth, pad2, store } from "./util.js";

/** 令和8〜10年度の稼働表（2026年11月時点で稼働表一覧に載っているもの）。 */
export const DEFAULT_SHEETS = [
  "1LqAFw6lvQdu-HSGyLDg0eiLfgEcZuJjqAzcj0gPc15o",   // R8年度
  "1DWMewhoj-vc3VNagQG7q7ZSx4aRs871b1-9Tpz7WVDA",   // R9年度
  "1y7LDN7Sh1UqAjiK6dWvC-LcJH5iiue9KylRc3ewJDTM",   // R10年度
];

const OFF_MARKS = CIRCLED + "★☆";
const LABELS = {
  "曜日": "weekday", "利用者名": "name", "地区": "area", "ヘルパーNo": "helpers",
  "ヘルパーNO": "helpers", "稼働数": "count", "区分": "kind", "休日": "off",
};
export const STATUS_NAMES = { fixed: "確定", open: "受付中", draft: "作成中", blank: "未作成" };
export const STATUS_NOTES = {
  fixed: "組合が確定した稼働表です。空いている日は毎月5日の午前中まで申し込めます。",
  open: "組合が受け入れられる人数（「◯名受入可」「満度です」）を書いています。",
  draft: "組合の書き込みがまだ無いので、空きは計算した目安です。",
  blank: "まだ稼働表が作られていません。空きは分かりません。",
};
const WEEK = "月火水木金土日";
const CIRCLED_RE = new RegExp(`[${CIRCLED}]`);
const CIRCLED_G = new RegExp(`[${CIRCLED}]`, "g");

function toInt(value) {
  const t = norm(value).replace(/\s+/g, "");
  return /^\d{1,3}$/.test(t) ? parseInt(t, 10) : null;
}

/** 「ヘルパーNo」の行に組合が書いた言葉 → 空き人数（言葉が無ければ null）。 */
export function statedAvailable(text) {
  const t = norm(text);
  if (!t) return null;
  const m = /(\d+)\s*名\s*受/.exec(t);
  if (m) return parseInt(m[1], 10);
  if (t.includes("満度") || t.includes("全休") || t.includes("満員")) return 0;
  return null;
}

// ---- 1か月分のシートを読む ------------------------------------------------------

const TITLE_RE = /R\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月/;

export function sheetTitle(rows) {
  for (const row of rows.slice(0, 4)) {
    for (const cell of row) {
      const t = norm(cell);
      const m = TITLE_RE.exec(t);
      if (m && +m[2] >= 1 && +m[2] <= 12) return [t, 2018 + +m[1], +m[2]];
    }
  }
  return null;
}

function staffList(rows, stop) {
  let head = null;
  for (let r = 0; r < Math.min(stop, rows.length) && !head; r++) {
    const c = rows[r].findIndex((cell) => norm(cell) === "専任ヘルパー");
    if (c >= 0) head = [r, c];
  }
  if (!head) {
    for (let r = 0; r < Math.min(stop, rows.length); r++) {
      const c = rows[r].findIndex((cell) => CIRCLED_RE.test(String(cell)));
      if (c >= 0) { head = [r - 1, c]; break; }
    }
  }
  if (!head) return [];
  const out = [], seen = new Set();
  const [r0, c0] = head;
  const re = new RegExp(`([${CIRCLED}])(.*)$`);
  for (const row of rows.slice(r0 + 1, stop)) {
    const cell = String(c0 < row.length ? row[c0] : "").trim();
    const m = re.exec(cell);
    if (!m) continue;
    const name = norm(m[2]);
    const no = [...CIRCLED].indexOf(m[1]) + 1;
    if (name && !seen.has(no)) {
      seen.add(no);
      out.push({ no, mark: m[1], name });
    }
  }
  return out;
}

function isDayRow(row) {
  const first = row.map(norm).find((v) => v) || "";
  return first === "日" && row.some((v) => toInt(v));
}

function dayLabels(row) {
  const out = [];
  row.forEach((v, c) => {
    if (norm(v) !== "日") return;
    const nxt = row.slice(c + 1).find((w) => norm(w)) || "";
    if (toInt(nxt)) out.push(c);
  });
  return out;
}

/** CSVの行 → 1か月分。見出しの年月が読めなければ null。 */
export function parseSheet(rowsIn) {
  const head = sheetTitle(rowsIn);
  if (!head) return null;
  const [title, year, month] = head;
  const lastDay = daysInMonth(year, month);
  const width = Math.max(0, ...rowsIn.map((r) => r.length));
  const rows = rowsIn.map((r) => r.concat(Array(width - r.length).fill("")));

  const dayRows = [];
  rows.forEach((row, r) => { if (isDayRow(row)) dayRows.push(r); });
  const staff = staffList(rows, dayRows.length ? dayRows[0] : rows.length);

  const days = new Map();
  dayRows.forEach((r0, n) => {
    const end = n + 1 < dayRows.length ? dayRows[n + 1] : rows.length;
    const labels = dayLabels(rows[r0]);
    labels.forEach((lc, li) => {
      const segEnd = li + 1 < labels.length ? labels[li + 1] : width;
      const cols = [];
      for (let c = lc + 1; c < segEnd; c++) if (toInt(rows[r0][c])) cols.push(c);
      const fieldRows = {};
      const noteRows = [];
      for (let r = r0 + 1; r < end; r++) {
        const label = norm(rows[r][lc]).replace(/\s+/g, "");
        if (label in LABELS) {
          if (!(LABELS[label] in fieldRows)) fieldRows[LABELS[label]] = r;
        } else if (!label && "off" in fieldRows && r - fieldRows.off <= 3) {
          noteRows.push(r);
        } else if (label && "off" in fieldRows) {
          break;
        }
      }
      cols.forEach((c, i) => {
        const d = toInt(rows[r0][c]);
        if (!d || d > lastDay || days.has(d)) return;
        const spanEnd = i + 1 < cols.length ? cols[i + 1] : segEnd;
        const span = [];
        for (let x = c; x < spanEnd; x++) span.push(x);
        days.set(d, readDay(rows, span, fieldRows, noteRows, year, month, d));
      });
    });
  });

  const staffN = staff.length;
  const all = [...days.values()];
  const hasBookings = all.some((x) => x.bookings.length);
  const hasOpen = all.some((x) => /受入|満度/.test(x.stated_text));
  let status;
  if (title.includes("確定")) status = "fixed";
  else if (hasOpen) status = "open";
  else if (hasBookings) status = "draft";
  else status = "blank";

  const outDays = [];
  for (let d = 1; d <= lastDay; d++) {
    const x = days.get(d) || readDay(rows, [], {}, [], year, month, d);
    const used = x.bookings.reduce((s, b) => s + b.count, 0);
    const computed = staffN ? Math.max(0, staffN - used - x.off.length) : null;
    let avail, source;
    if (x.stated != null) { avail = x.stated; source = "stated"; }
    else if (x.events.length && !x.bookings.length) { avail = 0; source = "event"; }
    else if (status === "blank" || computed == null) { avail = null; source = ""; }
    else { avail = computed; source = "computed"; }
    outDays.push({ ...x, avail, source, used });
  }
  return {
    ym: `${year}-${pad2(month)}`, year, month, title, status, status_name: STATUS_NAMES[status],
    staff, days: outDays,
  };
}

function readDay(rows, span, fieldRows, noteRows, year, month, d) {
  const cell = (key, c) => {
    const r = fieldRows[key];
    return r != null ? String(rows[r][c]).trim() : "";
  };
  const bookings = [], events = [], off = [], statedTexts = [];
  for (const c of span) {
    const helpers = cell("helpers", c);
    const said = norm(helpers);
    if (said && !CIRCLED_RE.test(helpers) && !/^[\d\s]+$/.test(said)) statedTexts.push(said);
    for (const ch of cell("off", c)) if (OFF_MARKS.includes(ch)) off.push(ch);
    const name = norm(cell("name", c));
    if (name) {
      let count = toInt(cell("count", c));
      const marks = (helpers.match(CIRCLED_G) || []).length;
      const area = norm(cell("area", c)), kind = norm(cell("kind", c));
      if (!count && !marks && !area && !kind) { events.push(name); continue; }
      count = count || marks || 1;
      bookings.push({ name, area, count, helpers: (helpers.match(CIRCLED_G) || []).join(""), kind });
    }
  }
  const notes = [];
  for (const r of noteRows) {
    for (const c of span) {
      const t = norm(rows[r][c]);
      if (t && !notes.includes(t)) notes.push(t);
    }
  }
  let stated = null;
  for (const t of statedTexts) {
    const v = statedAvailable(t);
    if (v != null) { stated = v; break; }
  }
  const dt = new Date(year, month - 1, d);
  return {
    date: `${year}-${pad2(month)}-${pad2(d)}`, day: d, weekday: WEEK[(dt.getDay() + 6) % 7],
    bookings, events, off, off_notes: notes, stated, stated_text: statedTexts.filter(Boolean).join(" "),
  };
}

export function parseCsvText(text) {
  return parseSheet(parseCsv(text));
}

// ---- 取り込み（スプレッドシート → 各月） ----------------------------------------------

const SHEET_ID_RE = /docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})/;
const SHEET_ITEM_RE = /items\.push\(\{name: "([^"]*)", pageUrl: "[^"]*", gid: "(\d+)"/g;
const MONTH_SHEET_RE = /^(\d{1,2})月稼/;
const YEAR_RE = /R\s*(\d{1,2})\s*年度/;
const TIMEOUT = 20000;
const WORKERS = 6;

/** 設定に貼られたURL（またはID）からスプレッドシートのIDを取り出す。読めなければ null。 */
export function sheetIdFromText(text) {
  const t = String(text || "").trim();
  const m = SHEET_ID_RE.exec(t);
  if (m) return m[1];
  return /^[\w-]{30,}$/.test(t) ? t : null;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store", credentials: "omit" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeJsString(s) {
  // シート名は JavaScript の文字列として埋め込まれている（月 のように書かれることがある）
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\(.)/g, "$1");
}

function decodeHtml(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

/** スプレッドシートの題名と、月のシート [[西暦, 月, gid]]（題名「R8年度稼働」から年度を決める）。 */
async function monthSheets(sheetId) {
  const html = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
  const m = /<title>([\s\S]*?)<\/title>/.exec(html);
  const title = m ? norm(decodeHtml(m[1]).replace(/\s*-\s*Google[\s\S]*$/, "")) : "";
  const fy = YEAR_RE.exec(title);
  const out = [];
  for (const it of html.matchAll(SHEET_ITEM_RE)) {
    const mm = MONTH_SHEET_RE.exec(norm(decodeJsString(it[1])));
    if (!mm || !fy) continue;
    const month = +mm[1];
    const year = 2018 + +fy[1] + (month <= 3 ? 1 : 0);
    out.push([year, month, it[2]]);
  }
  return [title, out];
}

/** 読みに行くスプレッドシートのID（重複なし）。 */
export async function sheetIds(extraUrls = []) {
  const ids = [...DEFAULT_SHEETS];
  try {
    // 公開場所に置いた sheets.json（新しい年度の稼働表ができたら、ここに足すだけで全員に届く）
    const r = await fetch("sheets.json", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      for (const x of j.sheets || []) {
        const id = sheetIdFromText(typeof x === "string" ? x : x.id || x.url);
        if (id) ids.push(id);
      }
    }
  } catch { /* 無くてもよい */ }
  for (const u of extraUrls) {
    const id = sheetIdFromText(u);
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

/**
 * 公開されている稼働表を全部（全年度・全月）取り込む。読めなかった月は前回の内容を残す。
 * progress(割合, 文) で進み具合を知らせる。
 */
export async function fetchAll({ extraUrls = [], previous = null, progress = () => {} } = {}) {
  progress(0.03, "稼働表の場所を確かめています…");
  const ids = await sheetIds(extraUrls);
  const found = new Map();       // "2026-10" → [id, gid]
  let sheetFailed = false;
  const problems = [];
  let n = 0;
  for (const sid of ids) {
    n++;
    progress(0.03 + 0.1 * n / ids.length, `稼働表の一覧を開いています…（${n}/${ids.length}）`);
    try {
      const [, sheets] = await monthSheets(sid);
      for (const [y, m, gid] of sheets) {
        const key = `${y}-${pad2(m)}`;
        if (!found.has(key)) found.set(key, [sid, gid]);
      }
    } catch (e) {
      sheetFailed = true;
      problems.push(`スプレッドシート ${sid.slice(0, 8)}… を開けませんでした`);
    }
  }
  if (!found.size) {
    throw new Error(navigator.onLine === false
      ? "インターネットにつながっていません。電波の良いところで「最新にする」を押してください。"
      : "稼働表を読めませんでした。少し時間をおいて「最新にする」を押してください。");
  }

  const kept = new Map((previous?.months || []).map((m) => [m.ym, m]));
  const results = new Map();
  const keepPrevious = (key, why) => {
    problems.push(why);
    if (kept.has(key)) results.set(key, { ...kept.get(key), stale: true });
  };

  const keys = [...found.keys()].sort();
  let done = 0;
  const queue = [...keys];
  async function worker() {
    while (queue.length) {
      const key = queue.shift();
      const [sid, gid] = found.get(key);
      const label = `${key.slice(0, 4)}年${+key.slice(5)}月`;
      try {
        const text = await fetchText(`https://docs.google.com/spreadsheets/d/${sid}/export?format=csv&gid=${gid}`);
        let month = null;
        try { month = parseCsvText(text); } catch { month = null; }
        if (!month) keepPrevious(key, `${label}: 表の形が読み取れませんでした`);
        else if (month.ym !== key) keepPrevious(key, `${label}: シートの見出しの年月が合わないので使いません`);
        else results.set(key, compactMonth(month));
      } catch {
        keepPrevious(key, `${label}: 読めませんでした`);
      }
      done++;
      progress(0.15 + 0.83 * done / keys.length, `月の稼働表を読んでいます…（${done}/${keys.length}）`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(WORKERS, keys.length) }, worker));

  if (sheetFailed) {
    for (const [key, m] of kept) {
      if (!results.has(key)) {
        results.set(key, { ...m, stale: true });
      }
    }
  }
  const months = [...results.keys()].sort().map((k) => results.get(k));
  if (!months.length) throw new Error("稼働表を1か月分も読めませんでした。少し時間をおいて、もう一度お試しください。");
  progress(1, "稼働表を取り込みました");
  return { fetched_at: new Date().toISOString(), months, problems };
}

/** 保存する形（画面で使う項目だけにして軽くする）。 */
function compactMonth(m) {
  return {
    ym: m.ym, year: m.year, month: m.month, status: m.status, staff: m.staff,
    days: m.days.map((d) => {
      const o = { day: d.day, avail: d.avail };
      if (d.source) o.source = d.source;
      if (d.bookings.length) o.bookings = d.bookings.map((b) => ({ name: b.name, area: b.area, count: b.count, helpers: b.helpers }));
      if (d.events.length) o.events = d.events;
      if (d.off.length) o.off = d.off;
      if (d.off_notes.length) o.off_notes = d.off_notes;
      if (d.stated_text) o.stated_text = d.stated_text;
      return o;
    }),
  };
}

// ---- 取り込んだものを使う -------------------------------------------------------

const KEY = "schedule";

export function loadSchedule() {
  const d = store.get(KEY);
  return d && Array.isArray(d.months) ? d : null;
}

export function saveSchedule(data) {
  return store.set(KEY, data);
}

export function ageMinutes(data) {
  if (!data?.fetched_at) return null;
  const t = Date.parse(data.fetched_at);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 60000);
}

/** その日の情報（無ければ null）。 */
export function dayInfo(data, iso) {
  const m = data?.months?.find((x) => x.ym === iso.slice(0, 7));
  if (!m) return null;
  const d = m.days[+iso.slice(8, 10) - 1];
  return d ? { ...d, month: m } : null;
}

export function monthInfo(data, ymText) {
  return data?.months?.find((x) => x.ym === ymText) || null;
}

/** 自分の利用（利用者名が同じ）か。 */
export function isOwn(booking, ownName) {
  const k = nameKey(ownName);
  return !!k && nameKey(booking.name) === k;
}

/** 稼働表に出てくる利用者名（セットアップで探す用）。地区は一番多く出てくるもの。 */
export function userNames(data) {
  const map = new Map();
  for (const m of data?.months || []) {
    for (const d of m.days) {
      for (const b of d.bookings || []) {
        const k = nameKey(b.name);
        if (!k) continue;
        const e = map.get(k) || { name: b.name, count: 0, areas: {}, last: "" };
        e.count++;
        if (b.area) e.areas[b.area] = (e.areas[b.area] || 0) + 1;
        const iso = `${m.ym}-${pad2(d.day)}`;
        if (iso > e.last) e.last = iso;
        map.set(k, e);
      }
    }
  }
  return [...map.values()].map((e) => {
    const area = Object.entries(e.areas).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    return { name: e.name, count: e.count, area, last: e.last };
  });
}

/** 名前で探す（空白は無視。一致 → 前方一致 → 部分一致の順）。 */
export function searchNames(data, query) {
  const q = nameKey(query);
  if (!q) return [];
  const all = userNames(data);
  const score = (n) => {
    const k = nameKey(n.name);
    if (k === q) return 0;
    if (k.startsWith(q)) return 1;
    if (k.includes(q)) return 2;
    if (q.includes(k) && k.length >= 2) return 3;
    return 9;
  };
  return all.map((n) => ({ ...n, score: score(n) })).filter((n) => n.score < 9)
    .sort((a, b) => a.score - b.score || b.count - a.count).slice(0, 8);
}
