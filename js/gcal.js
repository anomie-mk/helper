// Googleカレンダーへの予定の追加（予定作成リンク）
//  Googleの許可（ログイン連携）は使わない。中身を入れた「予定を作る画面」のリンクを開き、
//  利用者がGoogleカレンダーで「保存」を押して登録する。アプリは利用者のカレンダーに触れない。

import { parseIso, addDays, reiwaLabel, half } from "./util.js";
import * as C from "./core.js";

function md(iso) {
  const d = parseIso(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const ymd = (iso) => iso.replace(/-/g, "");

/**
 * 申込書の行ごとに1件の終日予定。期間は開始日〜最終日の翌日（ヘルパーは開始日の午後〜最終日の翌日の午前）。
 */
export function buildEvents(app, filename) {
  return app.rows.map((row) => {
    const r = C.tidyRow(row);
    const dates = C.rowDates(r);
    const first = dates[0], lastDay = dates[dates.length - 1];
    const leave = addDays(lastDay, 1);              // ヘルパーが帰る日（最終日の翌日の午前）
    const people = +half(r.people) || 1;
    const meeting = r.meeting ? C.MEETING_NAMES[r.meeting] : "";
    const time = C.normalizeTime(r.time);
    const details = [
      `${md(first)}(午後)～${md(leave)}(午前)まで`,
      `希望人員：${people}名`,
      meeting || time ? `打合せ：${[meeting, time ? `${time}時頃` : ""].filter(Boolean).join("・")}` : "",
      `申込日：${reiwaLabel(app.applyDate)}`,
      `申込書：${filename}`,
    ].filter(Boolean).join("\n");
    const title = `ヘルパー利用(${dates.length}日×${people}名)`;
    // 終日予定の終わりは「次の日」で指定する決まり
    const q = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${ymd(first)}/${ymd(addDays(leave, 1))}`, details });
    return {
      title,
      label: `${md(first)}〜${md(leave)}　${dates.length}日×${people}名`,
      url: `https://calendar.google.com/calendar/render?${q}`,
    };
  });
}
