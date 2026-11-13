// 申込書PDFを作る（スマホの中だけで作る。どこにも送らない）
//
//  白紙の様式（img/form-blank.png）に、文字と丸を描いて1枚の画像にし、それを1ページのPDFに包む。
//  紙面の位置は既存システムの fill_form.py と同じ（様式のスキャン画像 1276×1767px を基準にした座標）。
//  日本語の文字はスマホの文字（フォント）で描くので、フォントをPDFに入れる必要がない。

const PAGE_W = 615.443;   // PDFのページの大きさ（pt）。様式と同じ
const PAGE_H = 850.643;
const IMG_W = 1276;       // 座標の基準（様式のスキャン画像）
const IMG_H = 1767;

const APPLY_DATE = { year: [877, 232], month: [977, 232], day: [1075, 232] };
const MONTH_BOX = [135, 515];
const ROW_Y = [673, 735, 797, 860, 922];
const ROW_X = {
  start_month: 105, start_day: 187, end_month: 310, end_day: 385, days: 492, people: 596,
  opt_denwa: 699, opt_toujitsu: 802, opt_zenjitsu: 906, time: 1037,
};
const OPTION_ELLIPSE = [52, 33];
const MEETING_KEY_TO_X = { denwa: "opt_denwa", toujitsu: "opt_toujitsu", zenjitsu: "opt_zenjitsu" };

// 申込者の欄（白紙の様式から牧野様の分を消したところに書く）
const DISTRICT_X = { makubetsu: 422, satsunai: 646, ikeda: 851, takashima: 1056 };
const DISTRICT_Y = 307;
const DISTRICT_BOX = [76, 39];      // 丸（角の丸い四角）の半幅・半高
const ADDRESS = [345, 383];         // 住所の書き出し（左端・行の中心）
const NAME = [345, 436];
const FIELD_RIGHT = 1150;           // 欄の右端（長い住所は文字を小さくして収める）

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';

let formImage = null;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("申込書の様式を読み込めませんでした。"));
    img.src = src;
  });
}

async function blankForm() {
  if (!formImage) formImage = await loadImage("img/form-blank.png");
  return formImage;
}

/**
 * 紙面を描いた canvas を返す。
 * data は core.toFormData() の形、profile は { district, address, formName }。
 */
export async function renderForm(data, profile) {
  const img = await blankForm();
  const W = img.naturalWidth, H = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("スマホのメモリが足りず、紙面を描けませんでした。アプリを開き直してから、もう一度お試しください。");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, W, H);
  c.drawImage(img, 0, 0, W, H);

  const sx = W / IMG_W, sy = H / IMG_H, pt = W / PAGE_W;
  c.fillStyle = "#000";
  c.strokeStyle = "#000";

  const centered = (x, y, text, size = 11, baselineRatio = 0.32) => {
    if (text === "" || text == null) return;
    c.font = `500 ${size * pt}px ${FONT}`;
    c.textAlign = "center";
    c.textBaseline = "alphabetic";
    c.fillText(String(text), x * sx, y * sy + size * pt * baselineRatio);
  };
  const ellipse = (x, y, hw, hh) => {
    c.save();
    c.lineWidth = 1.4 * pt;
    c.beginPath();
    c.ellipse(x * sx, y * sy, hw * sx, hh * sy, 0, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  };
  const leftText = (x, y, text, size) => {
    if (!text) return;
    let s = size * pt;
    const maxW = (FIELD_RIGHT - x) * sx;
    c.textAlign = "left";
    c.textBaseline = "middle";
    for (; s > 6 * pt; s -= 0.5 * pt) {
      c.font = `400 ${s}px ${FONT}`;
      if (c.measureText(text).width <= maxW) break;
    }
    c.fillText(text, x * sx, y * sy);
  };

  // 申込者
  if (profile?.district && DISTRICT_X[profile.district]) {
    const [hw, hh] = DISTRICT_BOX;
    const x = DISTRICT_X[profile.district] * sx, y = DISTRICT_Y * sy;
    c.save();
    c.lineWidth = 2.2 * pt;
    c.beginPath();
    roundRect(c, x - hw * sx, y - hh * sy, 2 * hw * sx, 2 * hh * sy, 14 * sx);
    c.stroke();
    c.restore();
  }
  leftText(ADDRESS[0], ADDRESS[1], profile?.address || "", 12.5);
  leftText(NAME[0], NAME[1], spacedName(profile?.formName || ""), 12.5);

  // 申込年月日・月分
  centered(...APPLY_DATE.year, data.apply_year, 12);
  centered(...APPLY_DATE.month, data.apply_month, 12);
  centered(...APPLY_DATE.day, data.apply_day, 12);
  // 「12・1」のような複数月は、枠（幅およそ110）に収まるところまで字を小さくする
  const um = String(data.usage_month ?? "");
  let umSize = 16;
  c.font = `500 ${umSize * pt}px ${FONT}`;
  const umW = c.measureText(um).width, umMax = 96 * sx;
  if (umW > umMax) umSize = Math.max(8, umSize * umMax / umW);
  centered(...MONTH_BOX, um, umSize);

  // 希望日の行
  data.rows.slice(0, ROW_Y.length).forEach((row, i) => {
    if (!row) return;
    const y = ROW_Y[i];
    centered(ROW_X.start_month, y, row.start_month, 12);
    centered(ROW_X.start_day, y, row.start_day, 12);
    if (row.end_month || row.end_day) {
      centered(ROW_X.end_month, y, row.end_month, 12);
      centered(ROW_X.end_day, y, row.end_day, 12);
    }
    centered(ROW_X.days, y, row.days, 12);
    centered(ROW_X.people, y, row.people, 12);
    if (MEETING_KEY_TO_X[row.meeting]) ellipse(ROW_X[MEETING_KEY_TO_X[row.meeting]], y, ...OPTION_ELLIPSE);
    if (row.time) centered(ROW_X.time, y, row.time, 11);
  });
  return canvas;
}

/** 氏名の姓と名のあいだの空白は全角1つにそろえる（様式の見た目に合わせる）。 */
function spacedName(name) {
  return String(name).trim().replace(/[\s　]+/g, "　");
}

function roundRect(c, x, y, w, h, r) {
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function canvasToJpeg(canvas, quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした。"))), "image/jpeg", quality);
  });
}

/** JPEG 1枚を1ページのPDFにする（PDFの決まりどおりに自前で組み立てる）。 */
export async function jpegToPdf(jpegBlob, pxW, pxH) {
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const w = PAGE_W.toFixed(3), h = PAGE_H.toFixed(3);
  const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = length;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");
  obj(5, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`);
  obj(6, `<< /Producer (Helper Application Form) /Title (Helper Application) >>`);
  const xref = length;
  let table = `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}

/** 申込書PDFを作る。{ pdf: Blob, previewUrl: 画面で見せる画像のURL } */
export async function makePdf(data, profile) {
  const canvas = await renderForm(data, profile);
  const w = canvas.width, h = canvas.height;
  let jpeg;
  try {
    jpeg = await canvasToJpeg(canvas, 0.85);
  } finally {
    releaseCanvas(canvas);
  }
  const pdf = await jpegToPdf(jpeg, w, h);
  return { pdf, previewUrl: URL.createObjectURL(jpeg) };
}

/** 使い終わった canvas のメモリを手放す（iPhoneは canvas の合計に上限があり、超えると描けなくなる）。 */
export function releaseCanvas(canvas) {
  try { canvas.width = 0; canvas.height = 0; } catch { /* 何もしない */ }
}
