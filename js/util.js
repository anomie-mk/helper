// 共通の小道具（文字の整え方・日付・保存・CSV）

export const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export const WEEKDAYS = "日月火水木金土";   // Date#getDay() の順
export const REIWA_OFFSET = 2018;          // 令和元年＝2019年

/** 全角数字・半角カナなどをそろえる（丸数字はヘルパー番号なので、そのまま残す）。 */
export function norm(value) {
  const text = String(value ?? "");
  let out = "";
  for (const ch of text) out += CIRCLED.includes(ch) ? ch : ch.normalize("NFKC");
  return out.trim();
}

/** 利用者名の比べ方（空白を無視）。 */
export function nameKey(value) {
  return norm(value).replace(/\s+/g, "");
}

/** 全角の数字・記号を半角にして前後の空白を取る（入力欄用）。 */
export function half(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

// ---- 日付 --------------------------------------------------------------------

export function pad2(n) { return String(n).padStart(2, "0"); }

export function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "2026-10-05" → Date（その日の0時）。読めなければ null。 */
export function parseIso(text) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(half(text).replace(/\//g, "-"));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

export function todayIso() { return isoDate(new Date()); }

export function addDays(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** 期間の日数（開始日〜終了日、両端を含む）。 */
export function daysBetween(startIso, endIso) {
  const a = parseIso(startIso), b = parseIso(endIso);
  return Math.round((b - a) / 86400000) + 1;
}

export function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }

export function ym(iso) { return iso.slice(0, 7); }

export function shiftYm(ymText, n) {
  const [y, m] = ymText.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** "2026-10-05" → "10月5日(月)" */
export function jpDate(iso, withYear = false) {
  const d = parseIso(iso);
  if (!d) return iso;
  const y = withYear ? `${d.getFullYear()}年` : "";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}

export function reiwaLabel(iso) {
  const d = parseIso(iso);
  if (!d) return "";
  return `令和${d.getFullYear() - REIWA_OFFSET}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// ---- 保存（スマホのブラウザ内。使えないときも動くように） ----------------------------------

const PREFIX = "helperApp.";

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* 何もしない */ }
  },
  clearAll() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
    } catch { /* 何もしない */ }
  },
};

// ---- CSV ---------------------------------------------------------------------

/** RFC 4180 のCSVを行の配列にする。 */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", i = 0, quoted = false;
  const s = String(text).replace(/^﻿/, "");
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
      if (ch === "\r" && s[i + 1] === "\n") i++;
      i++; continue;
    }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---- 画面 --------------------------------------------------------------------

export function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 配列の最後（古いiPhoneには Array#at が無いため）。 */
export function last(arr) { return arr.length ? arr[arr.length - 1] : undefined; }

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
