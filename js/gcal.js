// Googleカレンダーへの予定の登録
//  サーバは使わない。Googleの許可画面へ移り、戻ってきたときにURLに付いてくる一時的な鍵（約1時間有効）で、
//  利用者自身のGoogleカレンダー（メインのカレンダー）に直接予定を入れる。
//  予定には、作成履歴ごと・行ごとに決まったID を付けるので、何度押しても同じ予定が二重に入らない。

import { store, parseIso, addDays, reiwaLabel, half } from "./util.js";
import * as C from "./core.js";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** 公開場所の sheets.json の googleClientId（空なら、この機能は出さない）。 */
export function clientId() { return store.get("googleClientId", ""); }
export function enabled() { return !!clientId(); }

/** 許可画面から戻る先（Google Cloud に登録したアドレスと同じにする）。 */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

// ---- 予定の中身 ------------------------------------------------------------------

function md(iso) {
  const d = parseIso(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 予定のID（Googleの決まり: 0-9 と a-v だけ、5文字以上）。 */
export function eventId(histId, i) {
  return `helper${String(histId).replace(/[^0-9]/g, "")}r${i}`;
}

/**
 * 申込書の行ごとに1件の終日予定。期間は開始日〜最終日の翌日（ヘルパーは開始日の午後〜最終日の翌日の午前）。
 */
export function buildEvents(app, filename, histId) {
  return app.rows.map((row, i) => {
    const r = C.tidyRow(row);
    const dates = C.rowDates(r);
    const first = dates[0], lastDay = dates[dates.length - 1];
    const leave = addDays(lastDay, 1);              // ヘルパーが帰る日（最終日の翌日の午前）
    const people = +half(r.people) || 1;
    const meeting = r.meeting ? C.MEETING_NAMES[r.meeting] : "";
    const time = C.normalizeTime(r.time);
    const lines = [
      `${md(first)}(午後)～${md(leave)}(午前)まで`,
      `希望人員：${people}名`,
      meeting || time ? `打合せ：${[meeting, time ? `${time}時頃` : ""].filter(Boolean).join("・")}` : "",
      `申込日：${reiwaLabel(app.applyDate)}`,
      `申込書：${filename}`,
      "（ヘルパー申込アプリで登録）",
    ].filter(Boolean);
    return {
      id: eventId(histId, i),
      summary: `ヘルパー利用(${dates.length}日×${people}名)`,
      description: lines.join("\n"),
      start: { date: first },
      end: { date: addDays(leave, 1) },   // 終日予定の終わりは「次の日」で指定する決まり
      label: `${md(first)}〜${md(leave)}　${dates.length}日×${people}名`,
    };
  });
}

// ---- 許可（鍵） --------------------------------------------------------------------

export function validToken() {
  const t = store.get("gToken", null);
  return t && t.exp > Date.now() + 60000 ? t.token : null;
}

function dropToken() { store.set("gToken", null); }

/** Googleの許可画面へ移る。戻ってきたら pending の続きをする。 */
export function startAuth(pending) {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  store.set("gPending", { ...pending, state, at: Date.now() });
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state,
  });
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/**
 * 許可画面から戻ってきたとき、URLの鍵を受け取る。
 * 戻り値: null（関係なし） / { pending, error } / { pending, token }
 */
export function takeAuthResult() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!/(^|&)(access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash);
  history.replaceState(null, "", location.pathname + location.search);   // 鍵をアドレス欄に残さない
  const pending = store.get("gPending", null);
  store.set("gPending", null);
  if (!pending || pending.state !== p.get("state") || Date.now() - pending.at > 30 * 60000) {
    return { pending: null, error: "Googleの画面からうまく戻れませんでした。もう一度「Googleカレンダーに入れる」を押してください" };
  }
  if (p.get("error")) {
    return { pending, error: p.get("error") === "access_denied" ? "Googleカレンダーへの許可がされませんでした" : `Googleの許可でエラー（${p.get("error")}）` };
  }
  const granted = p.get("scope") || "";
  if (granted && !granted.split(" ").includes(SCOPE)) {
    return { pending, error: "カレンダーの予定を入れる許可にチェックが入っていませんでした。もう一度押して、チェックを入れて許可してください" };
  }
  const token = p.get("access_token");
  store.set("gToken", { token, exp: Date.now() + (+p.get("expires_in") || 3600) * 1000 });
  return { pending, token };
}

// ---- 登録 ----------------------------------------------------------------------

class AuthError extends Error {}
export function isAuthError(e) { return e instanceof AuthError; }

async function call(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { dropToken(); throw new AuthError("Googleの許可が切れました"); }
  return res;
}

/**
 * 予定を入れる。すでに同じIDの予定があれば（消してあっても）、中身を今のものにして残す。
 * 戻り値: { added, updated }
 */
export async function insertEvents(events, token) {
  let added = 0, updated = 0;
  for (const ev of events) {
    const { label, ...body } = ev;
    let res = await call("POST", API, token, body);
    if (res.status === 409) {
      res = await call("PUT", `${API}/${encodeURIComponent(ev.id)}`, token, { ...body, status: "confirmed" });
      if (res.ok) { updated++; continue; }
    } else if (res.ok) { added++; continue; }
    let msg = `${res.status}`;
    try { msg = (await res.json())?.error?.message || msg; } catch { /* そのまま */ }
    throw new Error(`予定を入れられませんでした（${label}）: ${msg}`);
  }
  return { added, updated };
}
