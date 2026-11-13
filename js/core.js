// 申込書の中身（既存の管理統合システムの kanri/helper/core.py から移したもの）
//
//  行（希望日）は { start, end, people, meeting, time }。start / end は "2026-10-05" の形。
//  end が空、または start と同じ日なら1日だけ（紙面には終了日にも開始日と同じ日を書き、「利用日数 1」）。

import { half, parseIso, REIWA_OFFSET, pad2, todayIso, jpDate, shiftYm as shiftYmLocal } from "./util.js";
import { dayInfo } from "./schedule.js";

export const MEETING_OPTIONS = [
  ["denwa", "電話での時間確認"],
  ["toujitsu", "当日打合せ"],
  ["zenjitsu", "前日打合せ"],
];
export const MEETING_NAMES = Object.fromEntries(MEETING_OPTIONS);
export const ROW_COUNT = 5;       // 様式の希望日の行数
export const MAX_ROW_DAYS = 31;   // 1行の期間の上限

export const DISTRICTS = [
  ["makubetsu", "幕別地区", "JA幕別"],
  ["satsunai", "札内地区", "JA札内"],
  ["ikeda", "池田地区", "JA十勝池田町"],
  ["takashima", "高島地区", "旧JA高島"],
];
export const DISTRICT_NAMES = Object.fromEntries(DISTRICTS.map(([k, n]) => [k, n]));

/** 稼働表の「地区」の1文字 → 申込書の所属地区。 */
export function districtFromArea(area) {
  const a = String(area || "");
  if (a.includes("札")) return "satsunai";
  if (a.includes("池")) return "ikeda";
  if (a.includes("幕")) return "makubetsu";
  if (a.includes("高")) return "takashima";
  return "";
}

export function newRow(defaults = {}, start = "", end = "", people = "1") {
  return { start, end, people: String(people), meeting: defaults.meeting || "", time: defaults.time || "" };
}

/** 行の利用日数（開始日が無ければ null）。 */
export function rowDays(row) {
  if (!parseIso(row.start)) return null;
  return rowDates(row).length;
}

/** 行の期間を整える（逆なら入れ替え、同じ日なら終了日を空に）。 */
export function tidyRow(row) {
  const r = { ...row };
  if (r.start && r.end && parseIso(r.start) && parseIso(r.end)) {
    if (r.end < r.start) [r.start, r.end] = [r.end, r.start];
    if (r.end === r.start) r.end = "";
  }
  return r;
}

/** 行が覆う日（"2026-10-05" の配列）。 */
export function rowDates(row) {
  const r = tidyRow(row);
  if (!parseIso(r.start)) return [];
  const out = [];
  const last = r.end && parseIso(r.end) ? r.end : r.start;
  let d = parseIso(r.start);
  for (let i = 0; i < 62; i++) {
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    out.push(iso);
    if (iso >= last) break;
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export function rowLabel(row) {
  const r = tidyRow(row);
  if (!parseIso(r.start)) return "（日付なし）";
  return r.end ? `${jpDate(r.start)} 〜 ${jpDate(r.end)}` : jpDate(r.start);
}

/** 希望時刻。「18時頃」「１８」と入れても「18」にそろえる（様式に「時頃」が印字済みのため）。 */
export function normalizeTime(text) {
  return half(text).replace(/\s*(時頃|時ごろ|時|頃|ごろ)$/, "").trim().replace(/：/g, ":");
}

export function checkTime(t) {
  if (!t) return true;
  const m = /^(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(t);
  return !!m && +m[1] <= 24 && (m[2] === undefined || +m[2] < 60);
}

/** 利用希望月分の既定（翌月）。 */
export function nextMonth(month) { return month < 12 ? month + 1 : 1; }

/** ファイル名「YY.MM(申請月YY.MM~MM)」（既存システムと同じ決め方）。 */
export function filenameBase(applyIso, rows) {
  const yy = (y) => pad2(y % 100);
  const a = parseIso(applyIso);
  const months = [];
  for (const row of rows) {
    const r = tidyRow(row);
    const s = parseIso(r.start);
    if (!s) continue;
    months.push([s.getFullYear(), s.getMonth() + 1]);
    const e = parseIso(r.end);
    if (e) months.push([e.getFullYear(), e.getMonth() + 1]);
  }
  if (!a || !months.length) return "ヘルパー申込書";
  months.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const first = months[0], last = months[months.length - 1];
  let usage;
  if (first[0] === last[0] && first[1] === last[1]) usage = `${yy(first[0])}.${pad2(first[1])}`;
  else if (first[0] === last[0]) usage = `${yy(first[0])}.${pad2(first[1])}~${pad2(last[1])}`;
  else usage = `${yy(first[0])}.${pad2(first[1])}~${yy(last[0])}.${pad2(last[1])}`;
  return `${yy(a.getFullYear())}.${pad2(a.getMonth() + 1)}(申請月${usage})`;
}

/**
 * 入力を確かめる。
 *  errors:   直さないとPDFを作れないもの [{ field, row, msg }]
 *  warnings: 作れるが確かめてほしいもの [{ row, msg }]
 */
export function validate(app, profile, schedule) {
  const errors = [], warnings = [];
  const err = (field, msg, row = null) => errors.push({ field, msg, row });
  const warn = (msg, row = null) => warnings.push({ msg, row });

  // 申込者（セットアップの内容）
  if (!profile?.formName) err("profile", "申込書に書く氏名が入っていません。「設定」で入れてください。");
  if (!profile?.address) err("profile", "申込書に書く住所が入っていません。「設定」で入れてください。");
  if (!profile?.district) err("profile", "所属地区が選ばれていません。「設定」で選んでください。");

  const applyDate = parseIso(app.applyDate);
  if (!applyDate) err("applyDate", "申込年月日を選んでください。");
  const um = +app.usageMonth;
  if (!(um >= 1 && um <= 12)) err("usageMonth", "利用希望月分（◯月分）を選んでください。");

  const used = app.rows.filter((r) => r.start || r.end);
  if (!used.length) {
    err("rows", "希望日がまだありません。カレンダーで日を押すか、「＋ 希望日を足す」で入れてください。");
  }
  if (app.rows.length > ROW_COUNT) err("rows", `希望日は${ROW_COUNT}行までです（申込書の行の数）。行を減らしてください。`);

  const today = todayIso();
  const allDates = [];
  app.rows.forEach((row, i) => {
    const n = i + 1;
    if (!row.start && !row.end) {
      err("start", "日付が入っていません。日付を選ぶか、この行を消してください。", i);
      return;
    }
    const s = parseIso(row.start), e = row.end ? parseIso(row.end) : null;
    if (!s) { err("start", "開始日を選んでください（終了日だけでは作れません）。", i); return; }
    if (row.end && !e) { err("end", "終了日の日付が正しくありません。", i); return; }
    const r = tidyRow(row);
    const days = rowDates(r).length;
    if (days > MAX_ROW_DAYS) err("end", `期間が長すぎます（${days}日）。日付を確かめてください。`, i);

    const people = half(row.people);
    if (!/^\d{1,2}$/.test(people) || +people < 1) err("people", "希望人員は1以上の数字にしてください。", i);
    if (row.meeting && !MEETING_NAMES[row.meeting]) err("meeting", "打合せ希望形態を選び直してください。", i);
    if (!row.meeting) warn(`${n}行目: 打合せ希望形態が選ばれていません（紙面に丸が付きません）。`, i);
    const t = normalizeTime(row.time);
    if (!checkTime(t)) err("time", "希望時刻は数字で入れてください（例: 18 や 18:30）。", i);

    if (r.start < today) warn(`${n}行目: 過ぎた日（${jpDate(r.start)}）が入っています。`, i);
    if (applyDate && parseIso(r.start) < applyDate) warn(`${n}行目: 希望日が申込年月日より前です。`, i);
    if (r.end && r.start.slice(0, 7) !== r.end.slice(0, 7)) warn(`${n}行目: 期間が月をまたいでいます。月ごとに行を分けると分かりやすくなります。`, i);

    // 稼働表との照らし合わせ
    if (schedule && /^\d+$/.test(people)) {
      const short = [], unknown = [];
      for (const iso of rowDates(r)) {
        allDates.push(iso);
        const info = dayInfo(schedule, iso);
        if (!info || info.avail == null) unknown.push(iso);
        else if (info.avail < +people) short.push(`${+iso.slice(8)}日(空き${info.avail}名)`);
      }
      if (short.length) warn(`${n}行目: 空きが足りない日があります（${short.join("・")}）。頼んでも受けてもらえないかもしれません。`, i);
      if (unknown.length) warn(`${n}行目: 稼働表がまだ無く、空きが分からない日があります。`, i);
    }
  });

  // 重なり
  const seen = new Set();
  const dup = new Set();
  app.rows.forEach((row) => rowDates(row).forEach((d) => { if (seen.has(d)) dup.add(d); seen.add(d); }));
  if (dup.size) err("rows", `同じ日が2つの行に入っています（${[...dup].sort().map((d) => jpDate(d)).join("・")}）。`);

  // 利用希望月分と希望日の月
  if (um >= 1 && um <= 12 && used.length) {
    const months = [...new Set(app.rows.flatMap((r) => rowDates(r)).map((d) => +d.slice(5, 7)))].sort((a, b) => a - b);
    if (months.length && !months.includes(um)) {
      warn(`利用希望月分（${um}月分）と希望日の月（${months.map((m) => `${m}月`).join("・")}）が違います。`, null);
    }
  }

  // 申込の期限（稼働表の注意書きより）
  deadlineNotes(app.rows).forEach((m) => warn(m, null));
  return { errors, warnings };
}

/** 5日（土日なら前の平日）。祝日は見ていない。 */
export function blankDeadline(year, month) {
  const d = new Date(year, month - 1, 5);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

/** 申込期限についての注意。 */
export function deadlineNotes(rows, now = new Date()) {
  const out = [];
  const months = [...new Set(rows.flatMap((r) => rowDates(r)).map((d) => d.slice(0, 7)))].sort();
  const thisYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  for (const ymText of months) {
    const [y, m] = ymText.split("-").map(Number);
    if (ymText < thisYm) continue;
    const dl = blankDeadline(y, m);
    const passed = now > new Date(dl.getFullYear(), dl.getMonth(), dl.getDate(), 12, 0);
    if (ymText === thisYm) {
      if (passed) out.push(`今月（${m}月）分の空いている日の申込は${dl.getMonth() + 1}月${dl.getDate()}日の午前中まででした。急ぐときは組合へ電話で相談してください。`);
      else out.push(`今月（${m}月）分の空いている日の申込は${dl.getMonth() + 1}月${dl.getDate()}日の午前中までです。`);
    } else if (ymText === shiftYmLocal(thisYm, 1) && now.getDate() > 1) {
      out.push(`来月（${m}月）分の通常の申込期限（毎月1日）は過ぎています。空いている日なら${m}月${dl.getDate()}日の午前中まで申し込めます。`);
    }
  }
  return out;
}

/** PDFに書く中身（既存システムの fill_form に渡すものと同じ形）。行は上から詰めて書く。 */
export function toFormData(app) {
  const a = parseIso(app.applyDate);
  return {
    apply_year: a.getFullYear() - REIWA_OFFSET,
    apply_month: a.getMonth() + 1,
    apply_day: a.getDate(),
    usage_month: +app.usageMonth,
    rows: app.rows.map((row) => {
      const r = tidyRow(row);
      const s = parseIso(r.start), e = r.end ? parseIso(r.end) : s;   // 1日だけの行は、終了日＝開始日
      return {
        start_month: s.getMonth() + 1, start_day: s.getDate(),
        end_month: e.getMonth() + 1, end_day: e.getDate(),
        days: rowDates(r).length, people: String(+half(r.people)),
        meeting: r.meeting || null, time: normalizeTime(r.time),
      };
    }),
  };
}

// ---- メールで送る ----------------------------------------------------------------

export const MAIL_SUBJECT = "酪農ヘルパー利用申請";

/** 希望日の入っている月（重なりなし・古い順）。例: [{year:2027, month:2}, …] */
export function usageMonths(rows) {
  const seen = new Map();
  for (const r of rows) {
    for (const iso of rowDates(r)) {
      const key = iso.slice(0, 7);
      if (!seen.has(key)) seen.set(key, { year: +iso.slice(0, 4), month: +iso.slice(5, 7) });
    }
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
}

/** 例: 「令和9年2月」「令和9年2月、3月」「令和8年12月、令和9年1月」 */
export function usageMonthsLabel(rows) {
  let prevYear = null;
  return usageMonths(rows).map(({ year, month }) => {
    const text = year === prevYear ? `${month}月` : `令和${year - REIWA_OFFSET}年${month}月`;
    prevYear = year;
    return text;
  }).join("、");
}

/** メールの件名と本文。利用者名は稼働表での名前（無ければ申込書の氏名）。 */
export function mailContent(app, profile = {}) {
  const user = (profile.userName || profile.formName || "").trim();
  const body = [`利用者名：${user}`, `利用希望月：${usageMonthsLabel(app.rows)}`].join("\n");
  return { subject: MAIL_SUBJECT, body };
}
