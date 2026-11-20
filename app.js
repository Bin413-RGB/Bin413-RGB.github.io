/* نبض الشبكة v2 — اختبار سرعة حقيقي عبر خوادم Cloudflare العامة (speed.cloudflare.com)
   كل الأرقام المعروضة مقاسة فعلياً في المتصفح. لا توجد قيم تقديرية أو وهمية. */
'use strict';

const CF = 'https://speed.cloudflare.com';
const IDLE_PINGS = 20;
const SAMPLE_MS = 250;
const PROBE_TIMEOUT = 4000;     // مهلة قياس الاستجابة تحت الحمل
const MON_TIMEOUT = 3000;       // مهلة طلب مراقب الاستجابة
const MIN_CHUNK = 100e3, MAX_DOWN_CHUNK = 25e6, MAX_UP_CHUNK = 16 * 1024 * 1024;
const CHUNK_SEC = 3.0;          // نستهدف أن يستغرق كل طلب ≈ 3 ثوانٍ بالسرعة الحالية (يقلل فجوات بدء الطلبات)
const HIST_KEY = 'nabd.history.v1', SET_KEY = 'nabd.settings.v1';

/* ================= أوضاع الاختبار =================
   max: أقصى مدة لكل مرحلة · minT: أقل مدة قبل الإيقاف المبكر
   auto: إيقاف تلقائي عندما تستقر السرعة (آخر ثانيتين ضمن ±6% تقريباً)
   capDown/capUp: سقف البيانات لكل مرحلة (لا يُطبَّق قبل 3 ثوانٍ كي تبقى النتيجة دقيقة) */
const MODES = {
  eco:     { name: 'اقتصادي', max: 8000,  minT: 4000, auto: true,  capDown: 150e6, capUp: 60e6, capMinT: 2000 },
  normal:  { name: 'عادي',    max: 10000, minT: 10000, auto: false, capDown: 1.5e9, capUp: 600e6 },
  precise: { name: 'دقيق',    max: 15000, minT: 15000, auto: false, capDown: 4e9,   capUp: 2e9 }
};
const CAP_MIN_T = 3000;
// عدد الاتصالات المتوازية حسب السرعة المقاسة (Mbps)
const streamsFor = mbps => mbps < 10 ? 3 : mbps < 50 ? 4 : mbps < 200 ? 5 : mbps < 800 ? 6 : 8;

/* ================= معايير التقييم (موثّقة) =================
   الدرجات: 3 = ممتاز، 2 = جيد، 1 = ضعيف
   - بث 4K: التحميل ≥ 25 Mbps ممتاز، ≥ 15 جيد، أقل = ضعيف
   - مكالمات الفيديو: تحميل ≥ 10 ورفع ≥ 5 واستجابة ≤ 100ms و Jitter ≤ 30 = ممتاز؛ تحميل ≥ 4 ورفع ≥ 2 واستجابة ≤ 150 = جيد
   - الألعاب: استجابة ≤ 40 و Jitter ≤ 10 و Bufferbloat ≤ 30 و تحميل ≥ 10 = ممتاز؛ ≤ 80 / ≤ 20 / ≤ 100 / ≥ 3 = جيد
   - Jitter: ≤ 5 ممتاز، ≤ 15 جيد، ≤ 30 متوسط، أكثر = ضعيف
   - Bufferbloat: ≤ 30 ممتاز، ≤ 100 متوسط، أكثر = سيئ
   - ثبات السرعة (معامل اختلاف عينات 0.5 ث): ≤ 10% ممتاز، ≤ 25% جيد، أكثر = متذبذب
   - التقييم العام = أدنى درجة بين الاستخدامات الثلاثة */
const TH = {
  k4: { ex: 25, ok: 15 },
  vid: { ex: { d: 10, u: 5, p: 100, j: 30 }, ok: { d: 4, u: 2, p: 150 } },
  game: { ex: { p: 40, j: 10, b: 30, d: 10 }, ok: { p: 80, j: 20, b: 100, d: 3 } },
  jit: [5, 15, 30], bloat: [30, 100], stab: [10, 25]
};
const GRADE = { 3: ['ممتاز', 'gr', '#22c55e'], 2: ['جيد', 'am', '#f59e0b'], 1: ['ضعيف', 'rd', '#ef4444'] };

// رموز مراكز Cloudflare (رموز المطارات IATA) → أسماء المدن بالعربية
const COLO = {
  RUH: 'الرياض', JED: 'جدة', DMM: 'الدمام', MED: 'المدينة المنورة',
  DXB: 'دبي', AUH: 'أبوظبي', FJR: 'الفجيرة', KWI: 'الكويت', BAH: 'البحرين', DOH: 'الدوحة', MCT: 'مسقط',
  AMM: 'عمّان', BEY: 'بيروت', BGW: 'بغداد', BSR: 'البصرة', EBL: 'أربيل', NJF: 'النجف', ISU: 'السليمانية', XNH: 'الناصرية',
  CAI: 'القاهرة', ALG: 'الجزائر', ORN: 'وهران', TUN: 'تونس', CMN: 'الدار البيضاء', KRT: 'الخرطوم',
  IST: 'إسطنبول', ADB: 'إزمير', KHI: 'كراتشي', LHE: 'لاهور', ISB: 'إسلام آباد', BOM: 'مومباي', DEL: 'نيودلهي', MAA: 'تشيناي', BLR: 'بنغالور',
  FRA: 'فرانكفورت', MRS: 'مرسيليا', LHR: 'لندن', MAN: 'مانشستر', AMS: 'أمستردام', CDG: 'باريس', MXP: 'ميلانو', FCO: 'روما', MAD: 'مدريد',
  VIE: 'فيينا', ATH: 'أثينا', SOF: 'صوفيا', OTP: 'بوخارست', WAW: 'وارسو', ARN: 'ستوكهولم', ZRH: 'زيورخ',
  SIN: 'سنغافورة', HKG: 'هونغ كونغ', NRT: 'طوكيو', KUL: 'كوالالمبور', CGK: 'جاكرتا', SYD: 'سيدني',
  IAD: 'واشنطن', EWR: 'نيويورك', ORD: 'شيكاغو', DFW: 'دالاس', ATL: 'أتلانتا', MIA: 'ميامي', LAX: 'لوس أنجلوس', SJC: 'سان خوسيه', SEA: 'سياتل', YYZ: 'تورونتو',
  NBO: 'نيروبي', JNB: 'جوهانسبرغ', LOS: 'لاغوس'
};
const COUNTRY = { SA: 'السعودية', AE: 'الإمارات', KW: 'الكويت', QA: 'قطر', BH: 'البحرين', OM: 'عُمان', EG: 'مصر', JO: 'الأردن', IQ: 'العراق', LB: 'لبنان', YE: 'اليمن', SY: 'سوريا', PS: 'فلسطين', SD: 'السودان', MA: 'المغرب', DZ: 'الجزائر', TN: 'تونس', LY: 'ليبيا', TR: 'تركيا', PK: 'باكستان', IN: 'الهند', US: 'الولايات المتحدة', GB: 'بريطانيا', DE: 'ألمانيا', FR: 'فرنسا', NL: 'هولندا' };

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const num = v => typeof v === 'number' && Number.isFinite(v);
const fmtS = v => !num(v) ? '—' : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
const fmtMs = v => !num(v) ? '—' : v >= 10 ? Math.round(v).toString() : v.toFixed(1);
const ltr = x => '\u2066' + x + '\u2069'; // عزل الأرقام والوحدات اللاتينية داخل النص العربي
const fmtMB = b => ltr(b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 10e6 ? Math.round(b / 1e6) + ' MB' : (b / 1e6).toFixed(1) + ' MB');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const coloName = c => c ? (COLO[c] ? `${COLO[c]} (${c})` : c) : '';
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) { } }; // يعمل في أندرويد فقط؛ الآيفون لا يدعم الاهتزاز من المتصفح
const pulse = el => { if (!el) return; el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); };

let settings = Object.assign({ mode: 'eco', showIp: false }, JSON.parse(localStorage.getItem(SET_KEY) || '{}'));
if (!MODES[settings.mode]) settings.mode = 'eco';
const saveSettings = () => localStorage.setItem(SET_KEY, JSON.stringify(settings));
let meta = null, trace = null, running = null, current = null, showAll = false, ipv = null, mon = null;

/* ================= الشبكة / الخادم ================= */
async function loadMeta() {
  // cdn-cgi/trace يسمح بالقراءة من أي موقع (CORS): ip، colo، loc، http، tls
  try {
    const t = await fetch(`${CF}/cdn-cgi/trace?r=${rnd()}`, { cache: 'no-store' }).then(r => r.text());
    trace = Object.fromEntries(t.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    meta = { ip: trace.ip, colo: trace.colo, country: trace.loc };
  } catch (e) { meta = null; }
  renderServer(); renderNet();
  return !!meta;
}
// فحص توفر IPv4 و IPv6: نقطتا Cloudflare Radar تعملان عبر بروتوكول واحد فقط لكل منهما
async function ipCheck(v) {
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 6000), t0 = performance.now();
  try {
    const j = await fetch(`https://ipv${v}-check-perf.radar.cloudflare.com/`, { cache: 'no-store', signal: ac.signal }).then(r => r.json());
    return { ok: j.ip_version === 'IPv' + v, ip: j.ip_address, asn: j.asn, city: j.city, country: j.country, colo: j.colo, ms: performance.now() - t0 };
  } catch (e) { return { ok: false }; } finally { clearTimeout(to); }
}
async function runIpCheck() {
  $('#ipInfo').innerHTML = '<div class="muted">جارٍ الفحص…</div>';
  const [v4, v6] = await Promise.all([ipCheck(4), ipCheck(6)]);
  ipv = { v4, v6 }; renderIp(); renderNet();
}
function connType() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c || !c.type || c.type === 'unknown') return '';
  return ({ wifi: 'Wi‑Fi', cellular: 'خلوي', ethernet: 'Ethernet', bluetooth: 'Bluetooth', wimax: 'WiMAX' })[c.type] || c.type;
}
function renderServer() {
  const dot = $('#srvDot');
  if (!meta) { dot.className = 'dot bad'; $('#srvTxt').textContent = navigator.onLine ? 'تعذّر الوصول لخادم القياس' : 'لا يوجد اتصال بالإنترنت'; $('#srvRight').textContent = ''; return; }
  dot.className = 'dot ok';
  $('#srvTxt').textContent = `الخادم: ${coloName(meta.colo) || 'Cloudflare'}`;
  $('#srvRight').textContent = [connType(), meta.ip ? (meta.ip.includes(':') ? 'IPv6' : 'IPv4') : ''].filter(Boolean).join(' · ');
}
const hidden = v => settings.showIp ? v : '•••• مخفي';
function renderNet() {
  const rows = [];
  const add = (k, v, extra = '') => v && rows.push(`<div class="row"><span>${k}${extra}</span><b>${esc(v)}</b></div>`);
  if (!meta && !trace) { $('#netInfo').innerHTML = '<div class="muted">تعذّر قراءة بيانات الشبكة. تأكد من الاتصال ثم اضغط ↻.</div>'; return; }
  const eye = `<button class="eye" id="eyeBtn">${settings.showIp ? 'إخفاء' : 'إظهار'}</button>`;
  add('خادم القياس', `${coloName(meta && meta.colo)} · Cloudflare`);
  add('عنوان IP العام', meta && meta.ip ? hidden(meta.ip) : '', eye);
  add('نوع العنوان المستخدم', meta && meta.ip ? (meta.ip.includes(':') ? 'IPv6' : 'IPv4') : '');
  const g = ipv && (ipv.v4.ok ? ipv.v4 : ipv.v6.ok ? ipv.v6 : null);
  if (g && g.asn) add('رقم الشبكة (ASN)', 'AS' + g.asn);
  if (g && (g.city || g.country)) add('موقعك التقريبي', hidden([g.city, COUNTRY[g.country] || g.country].filter(Boolean).join('، ')));
  else add('الدولة', meta && meta.country ? (COUNTRY[meta.country] || meta.country) : '');
  add('بروتوكول HTTP', trace && trace.http ? trace.http.toUpperCase().replace('HTTP/', 'HTTP/') : '');
  add('تشفير الاتصال', trace && trace.tls);
  add('نوع الاتصال', connType());
  add('حالة المتصفح', navigator.onLine ? 'متصل' : 'غير متصل');
  $('#netInfo').innerHTML = rows.join('');
}
function renderIp() {
  if (!ipv) return;
  const row = (k, r) => `<div class="row"><span>${k}</span><b class="${r.ok ? 'st-ok' : 'st-no'}">${r.ok ? '✓ متاح' + (r.ip ? ' · ' + esc(hidden(r.ip)) : '') : '✕ غير متاح'}</b></div>`;
  $('#ipInfo').innerHTML = row('IPv4', ipv.v4) + row('IPv6', ipv.v6);
}

/* ================= أدوات القياس ================= */
// زمن الاستجابة لطلب 0 بايت: Resource Timing (من إرسال الطلب حتى أول بايت) مطروحاً منه زمن معالجة الخادم المُعلن في Server-Timing
async function ping(signal) {
  const url = `${CF}/__down?bytes=0&r=${rnd()}`;
  const t0 = performance.now();
  const r = await fetch(url, { cache: 'no-store', signal });
  await r.arrayBuffer();
  let ms = performance.now() - t0;
  const e = performance.getEntriesByName(url).pop();
  if (e && e.requestStart > 0 && e.responseStart > e.requestStart) {
    let v = e.responseStart - e.requestStart;
    const st = (e.serverTiming || []).find(s => s.name === 'cfSpeedWorker' || s.name === 'cfRequestDuration');
    if (st && st.duration > 0 && st.duration < v) v -= st.duration;
    ms = v;
  }
  if (performance.getEntriesByType('resource').length > 200) performance.clearResourceTimings();
  return ms;
}

// عدّاد بايتات + قرار الإيقاف (المدة / السقف / الاستقرار)
function runMeter(ctx, cfg, cap, onTick) {
  const m = { bytes: 0, samples: [], lives: [], series: [], start: performance.now(), live: 0, reason: 'time' };
  m.done = new Promise(resolve => {
    const timer = setInterval(() => {
      const t = performance.now() - m.start;
      m.samples.push({ t, b: m.bytes });
      const past = m.samples.find(s => s.t >= t - 1000) || m.samples[0];
      m.live = t - past.t > 0 ? (m.bytes - past.b) * 8 / (t - past.t) / 1000 : 0; // Mbps
      m.lives.push(m.live);
      if (t > 300) m.series.push([t / 1000, m.live]);
      onTick(m.live, t, m.bytes);
      let stop = t >= cfg.max;
      if (!stop && t >= (cfg.capMinT || CAP_MIN_T) && m.bytes >= cap) { stop = true; m.reason = 'cap'; }
      if (!stop && cfg.auto && t >= cfg.minT) {
        const last = m.lives.slice(-8); // آخر ثانيتين
        const lo = Math.min(...last), hi = Math.max(...last);
        if (lo > 0 && hi / lo <= 1.12) { stop = true; m.reason = 'stable'; }
      }
      if (stop || ctx.cancelled) { clearInterval(timer); resolve(); }
    }, SAMPLE_MS);
    ctx.cancelP.then(() => { clearInterval(timer); resolve(); });
  });
  m.finish = () => {
    const t = performance.now() - m.start;
    m.samples.push({ t, b: m.bytes });
    const warm = Math.min(2000, t * 0.35); // نستبعد فترة التسارع (TCP slow-start وزيادة الاتصالات)
    const w = m.samples.find(s => s.t >= warm) || m.samples[0];
    const speed = t > w.t ? (m.bytes - w.b) * 8 / (t - w.t) / 1000 : 0;
    const win = [];
    for (let i = 0; i < m.samples.length; i++) {
      const a = m.samples[i]; if (a.t < warm) continue;
      const b = m.samples.find(s => s.t >= a.t + 500); if (!b) break;
      win.push((b.b - a.b) * 8 / (b.t - a.t) / 1000); i += 1;
    }
    const mu = win.length ? mean(win) : 0;
    const cv = win.length > 2 && mu > 0 ? Math.sqrt(mean(win.map(x => (x - mu) ** 2))) / mu * 100 : NaN;
    return { speed, cv, bytes: m.bytes, ms: t, reason: m.reason, series: m.series };
  };
  return m;
}

async function downloadPhase(ctx, cfg, onTick) {
  let stop = false, n = 0, maxN = 0; const ac = new AbortController(); ctx.aborts.add(ac);
  const m = runMeter(ctx, cfg, cfg.capDown, (live, t, b) => { grow(live); onTick(live, t, b, n); });
  const chunk = () => Math.round(clamp(m.live * 1e6 / 8 * CHUNK_SEC / Math.max(1, n), MIN_CHUNK, MAX_DOWN_CHUNK));
  const worker = async () => {
    while (!stop) {
      try {
        const r = await fetch(`${CF}/__down?bytes=${chunk()}&r=${rnd()}`, { cache: 'no-store', signal: ac.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const rd = r.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; m.bytes += value.byteLength; }
      } catch (e) { if (stop || ctx.cancelled) return; ctx.errors++; if (ctx.errors > 40) return; await sleep(250); }
    }
  };
  const ws = [];
  const grow = live => { const want = streamsFor(live); while (n < want && !stop) { n++; ws.push(worker()); } maxN = Math.max(maxN, n); };
  grow(0);
  const loaded = loadedPings(ctx, () => stop);
  await m.done;
  stop = true; ac.abort();
  await Promise.allSettled(ws);
  const res = m.finish(); res.loaded = await loaded; res.streams = maxN;
  return res;
}

async function uploadPhase(ctx, cfg, onTick) {
  let stop = false, n = 0, maxN = 0; const xhrs = new Set();
  ctx.aborts.add({ abort: () => xhrs.forEach(x => x.abort()) });
  const base = new Uint8Array(65536); crypto.getRandomValues(base);
  const m = runMeter(ctx, cfg, cfg.capUp, (live, t, b) => { grow(live); onTick(live, t, b, n); });
  const chunk = () => Math.round(clamp(m.live * 1e6 / 8 * CHUNK_SEC / Math.max(1, n), MIN_CHUNK, MAX_UP_CHUNK));
  const makeBlob = size => { const k = Math.floor(size / 65536), parts = Array(k).fill(base); parts.push(base.subarray(0, size - k * 65536)); return new Blob(parts); };
  const worker = () => new Promise(resolve => {
    const go = () => {
      if (stop || ctx.cancelled) return resolve();
      const size = chunk(), x = new XMLHttpRequest(); let last = 0; xhrs.add(x);
      x.open('POST', `${CF}/__up?r=${rnd()}`);
      x.upload.onprogress = e => { m.bytes += e.loaded - last; last = e.loaded; };
      x.onload = () => { xhrs.delete(x); if (last < size) m.bytes += size - last; go(); };
      x.onerror = () => { xhrs.delete(x); ctx.errors++; if (ctx.errors > 40) return resolve(); setTimeout(go, 250); };
      x.onabort = () => { xhrs.delete(x); resolve(); };
      x.send(makeBlob(size));
    };
    go();
  });
  const ws = [];
  const grow = live => { const want = streamsFor(live); while (n < want && !stop) { n++; ws.push(worker()); } maxN = Math.max(maxN, n); };
  grow(0);
  const loaded = loadedPings(ctx, () => stop);
  await m.done;
  stop = true; xhrs.forEach(x => x.abort());
  await Promise.race([Promise.allSettled(ws), sleep(1500)]);
  const res = m.finish(); res.loaded = await loaded; res.streams = maxN;
  return res;
}

// الاستجابة أثناء التحميل/الرفع (Bufferbloat). الطلب الذي لا يرد خلال المهلة يُحتسب بقيمة المهلة (حد أدنى للتأخير)
async function loadedPings(ctx, isStopped) {
  const out = []; await sleep(1200);
  while (!isStopped() && !ctx.cancelled) {
    const ac = new AbortController(); ctx.aborts.add(ac);
    let timedOut = false; const t0 = performance.now();
    const to = setTimeout(() => { timedOut = true; ac.abort(); }, PROBE_TIMEOUT);
    try { const v = await ping(ac.signal); if (!isStopped()) out.push(v); }
    catch (e) { if (timedOut && !isStopped()) out.push(performance.now() - t0); }
    clearTimeout(to); ctx.aborts.delete(ac);
    await sleep(400);
  }
  return out;
}

/* ================= واجهة الاختبار ================= */
let gaugeMax = 100;
const SCALES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
function setGauge(v, mode) {
  const n = $('#gNum'), u = $('#gUnit'), arc = $('#arc');
  if (mode === 'ping') { n.textContent = fmtMs(v); u.textContent = 'ms'; arc.setAttribute('stroke-dasharray', `${Math.min(1, v / 200) * 471.24} 628.32`); arc.style.opacity = 1; $('#gMax').textContent = '200'; return; }
  u.textContent = 'Mbps';
  if (v > gaugeMax * 0.92) gaugeMax = SCALES.find(s => s > v * 1.1) || SCALES[SCALES.length - 1];
  $('#gMax').textContent = gaugeMax;
  n.textContent = fmtS(v);
  arc.setAttribute('stroke', mode === 'up' ? 'url(#gUp)' : 'url(#gDown)');
  const f = clamp(v / gaugeMax, 0, 1);
  arc.setAttribute('stroke-dasharray', `${f * 471.24} 628.32`); arc.style.opacity = f > 0.002 ? 1 : 0;
}
function setTag(txt, cls) { const t = $('#gTag'); t.textContent = txt; t.className = 'tag' + (cls ? ' ' + cls : ''); pulse(t); }

function chartSVG(down, up, W, H, dur) {
  const all = [...down, ...up].map(p => p[1]);
  const max = Math.max(1, ...all) * 1.12;
  const X = t => (t / dur) * W, Y = v => H - 4 - (v / max) * (H - 10);
  const path = s => s.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
  let g = `<defs><linearGradient id="ga${H}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b6cff" stop-opacity=".28"/><stop offset="1" stop-color="#2b6cff" stop-opacity="0"/></linearGradient></defs>`;
  g += `<g class="grid" stroke="#eef1f6"><line x1="0" y1="${H * .3}" x2="${W}" y2="${H * .3}"/><line x1="0" y1="${H * .62}" x2="${W}" y2="${H * .62}"/></g>`;
  if (down.length > 1) {
    const d = path(down);
    g += `<path d="${d} L${X(down[down.length - 1][0]).toFixed(1)} ${H} L${X(down[0][0]).toFixed(1)} ${H}Z" fill="url(#ga${H})"/>`;
    g += `<path d="${d}" fill="none" stroke="#2b6cff" stroke-width="2.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }
  if (up.length > 1) g += `<path d="${path(up)}" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  return g;
}

function gradeJit(j) { return j <= TH.jit[0] ? 3 : j <= TH.jit[1] ? 2 : j <= TH.jit[2] ? 1.5 : 1; }
function qCard(id, txt, lbl, cls, pct, color) {
  $('#' + id).textContent = txt; const l = $('#' + id + 'L'); l.textContent = lbl; l.className = cls;
  const b = $('#' + id + 'B'); b.style.width = pct + '%'; b.style.background = color;
}
function renderQuality(r) {
  if (!r) { ['qJit', 'qStab', 'qBd', 'qBu'].forEach(id => qCard(id, '—', '', '', 0, 'transparent')); return; }
  if (num(r.jitter)) {
    const g = gradeJit(r.jitter);
    const [l, c, col] = g === 3 ? ['ممتاز', 'gr', '#22c55e'] : g === 2 ? ['جيد', 'gr', '#84cc16'] : g === 1.5 ? ['متوسط', 'am', '#f59e0b'] : ['ضعيف', 'rd', '#ef4444'];
    qCard('qJit', fmtMs(r.jitter) + ' ms', l, c, Math.max(8, 100 - r.jitter * 2.5), col);
  }
  if (num(r.stab)) {
    const [l, c, col] = r.stab <= TH.stab[0] ? ['ممتاز', 'gr', '#22c55e'] : r.stab <= TH.stab[1] ? ['جيد', 'am', '#f59e0b'] : ['متذبذب', 'rd', '#ef4444'];
    qCard('qStab', '±' + Math.round(r.stab) + ' %', l, c, Math.max(8, 100 - r.stab * 2), col);
  }
  const bl = (id, v) => {
    if (!num(v)) return qCard(id, '—', 'غير متاح', 'muted', 0, 'transparent');
    const [l, c, col] = v <= TH.bloat[0] ? ['ممتاز', 'gr', '#22c55e'] : v <= TH.bloat[1] ? ['متوسط', 'am', '#f59e0b'] : ['سيئ', 'rd', '#ef4444'];
    qCard(id, '+' + Math.round(v) + ' ms', l, c, Math.max(8, 100 - v / 2), col);
  };
  if ('bloatDown' in r) bl('qBd', r.bloatDown);
  if ('bloatUp' in r) bl('qBu', r.bloatUp);
}

function setRunningUI(on) {
  $('#startBtn').classList.toggle('hidden', on);
  $('#stopBtn').classList.toggle('hidden', !on);
  document.querySelectorAll('.tab .ti').forEach(b => b.disabled = on && b.dataset.go !== 'test');
  document.querySelector('.tab').style.opacity = on ? .55 : 1;
}

async function runTest() {
  if (running) return;
  if (mon) stopMonitor();
  if (!navigator.onLine) return toast('لا يوجد اتصال بالإنترنت');
  buzz();
  const cfg = MODES[settings.mode];
  let cancel; const ctx = { cancelled: false, errors: 0, aborts: new Set(), cancelP: new Promise(r => cancel = r) };
  ctx.cancel = () => { ctx.cancelled = true; ctx.aborts.forEach(a => a.abort()); cancel(); };
  running = ctx; setRunningUI(true);
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { }
  const r = { t: Date.now(), mode: settings.mode };
  const live = { down: [], up: [] }, durS = cfg.max / 1000;
  const drawLive = () => { $('#liveChart').innerHTML = chartSVG(live.down, live.up, 330, 56, durS); };
  let usedDown = 0, usedUp = 0;
  const showUsage = (extra = '') => { $('#usage').textContent = `البيانات المستهلكة: ${fmtMB(usedDown + usedUp)} · الوضع: ${cfg.name}${extra}`; };
  ['#vDown', '#vUp', '#vPing'].forEach(s => $(s).textContent = '—'); renderQuality(null); drawLive(); showUsage();
  gaugeMax = 100; setGauge(0, 'down');
  try {
    if (!meta) await loadMeta();
    if (!meta) throw new Error('meta');
    // 1) الاستجابة وقت الهدوء
    setTag('⏱ جارٍ قياس الاستجابة');
    await ping(); // طلب إحماء لفتح الاتصال (لا يُحتسب)
    const pings = [];
    for (let i = 0; i < IDLE_PINGS && !ctx.cancelled; i++) {
      const ac = new AbortController(); ctx.aborts.add(ac);
      pings.push(await ping(ac.signal)); ctx.aborts.delete(ac);
      setGauge(pings[pings.length - 1], 'ping'); $('#vPing').textContent = fmtMs(median(pings));
    }
    if (ctx.cancelled) throw new Error('cancel');
    r.ping = median(pings); r.pingMin = Math.min(...pings);
    r.jitter = pings.length > 1 ? mean(pings.slice(1).map((v, i) => Math.abs(v - pings[i]))) : NaN;
    $('#vPing').textContent = fmtMs(r.ping); renderQuality(r); buzz();
    // 2) التحميل
    setTag('↓ جارٍ قياس التحميل'); setGauge(0, 'down');
    const d = await downloadPhase(ctx, cfg, (v, t, b, n) => { usedDown = b; setGauge(v, 'down'); $('#vDown').textContent = fmtS(v); if (t > 300) live.down.push([t / 1000, v]); drawLive(); showUsage(` · ${ltr(n)} اتصالات`); });
    if (ctx.cancelled) throw new Error('cancel');
    Object.assign(r, { down: d.speed, stab: d.cv, bytesDown: d.bytes, tDown: d.ms, stopDown: d.reason, nDown: d.streams });
    r.sDown = live.down.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]);
    r.loadedDown = median(d.loaded); r.bloatDown = d.loaded.length ? Math.max(0, r.loadedDown - r.ping) : null;
    $('#vDown').textContent = fmtS(r.down); renderQuality(r); buzz();
    // 3) الرفع
    setTag('↑ جارٍ قياس الرفع', 'vio'); gaugeMax = 100; setGauge(0, 'up');
    const u = await uploadPhase(ctx, cfg, (v, t, b, n) => { usedUp = b; setGauge(v, 'up'); $('#vUp').textContent = fmtS(v); if (t > 300) live.up.push([t / 1000, v]); drawLive(); showUsage(` · ${ltr(n)} اتصالات`); });
    if (ctx.cancelled) throw new Error('cancel');
    Object.assign(r, { up: u.speed, bytesUp: u.bytes, tUp: u.ms, stopUp: u.reason, nUp: u.streams });
    r.sUp = live.up.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]);
    r.loadedUp = median(u.loaded); r.bloatUp = u.loaded.length ? Math.max(0, r.loadedUp - r.ping) : null;
    $('#vUp').textContent = fmtS(r.up); renderQuality(r);
    if (!(r.down > 0) || !(r.up > 0)) throw new Error('zero');
    r.dur = +(Math.max(r.tDown, r.tUp) / 1000).toFixed(2);
    Object.assign(r, { colo: meta.colo, country: meta.country, conn: connType(), ipv: meta.ip && meta.ip.includes(':') ? 6 : 4 });
    $('#liveChart').innerHTML = chartSVG(r.sDown, r.sUp, 330, 56, r.dur);
    setGauge(r.down, 'down'); setTag('✓ اكتمل الاختبار', 'gr'); buzz(); pulse(document.querySelector('.gcard'));
    $('#usage').textContent = `استهلك الاختبار ${fmtMB(r.bytesDown + r.bytesUp)} · الوضع: ${cfg.name}`;
    const hist = loadHist(); hist.unshift(r); saveHist(hist.slice(0, 50));
    current = r;
    setTimeout(() => { if (!running) go('result'); }, 900);
  } catch (e) {
    if (ctx.cancelled) { setTag('أُوقف الاختبار'); }
    else { console.warn('test failed', e); setTag('تعذّر إكمال الاختبار', 'err'); toast('تعذّر الاتصال بخادم القياس. تحقق من الإنترنت وحاول مجدداً.'); }
  } finally {
    ctx.aborts.forEach(a => { try { a.abort(); } catch (e) { } });
    try { wake && wake.release(); } catch (e) { }
    running = null; setRunningUI(false);
    $('#startBtn').textContent = loadHist().length ? 'إعادة الاختبار' : 'ابدأ الاختبار';
  }
}

/* ================= مراقب الاستجابة (60 ث، طلب كل ثانية) ================= */
function startMonitor() {
  if (running || mon) return;
  buzz();
  const m = mon = { vals: [], to: 0, n: 0, stop: false, ac: null };
  $('#monBtn').textContent = 'إيقاف المراقبة'; $('#monBtn').classList.add('stopping');
  renderMon();
  (async () => {
    for (let i = 0; i < 60 && !m.stop; i++) {
      const tStart = performance.now();
      const ac = m.ac = new AbortController(); let timedOut = false;
      const to = setTimeout(() => { timedOut = true; ac.abort(); }, MON_TIMEOUT);
      try { const v = await ping(ac.signal); m.vals.push(v); m.series = (m.series || []).concat([[i, v]]); }
      catch (e) { if (m.stop) break; m.to++; m.series = (m.series || []).concat([[i, null]]); }
      clearTimeout(to); m.n++;
      renderMon();
      const wait = 1000 - (performance.now() - tStart);
      if (wait > 0 && !m.stop) await sleep(wait);
    }
    if (mon === m) finishMon();
  })();
}
function stopMonitor() { if (!mon) return; mon.stop = true; try { mon.ac && mon.ac.abort(); } catch (e) { } finishMon(); }
function finishMon() { const m = mon; mon = null; $('#monBtn').textContent = 'ابدأ المراقبة'; $('#monBtn').classList.remove('stopping'); if (m) renderMon(m, true); }
function renderMon(m = mon, done = false) {
  if (!m) return;
  const v = m.vals;
  $('#mMin').textContent = v.length ? fmtMs(Math.min(...v)) : '—';
  $('#mAvg').textContent = v.length ? fmtMs(mean(v)) : '—';
  $('#mMax').textContent = v.length ? fmtMs(Math.max(...v)) : '—';
  $('#mJit').textContent = v.length > 1 ? fmtMs(mean(v.slice(1).map((x, i) => Math.abs(x - v[i])))) : '—';
  $('#mTo').textContent = m.n ? m.to : '—'; $('#mToS').textContent = 'من ' + m.n;
  $('#mTo').className = m.to ? 'rd' : '';
  $('#monProg').textContent = (done ? `انتهت · ${m.n} طلب` : `${m.n} / 60 ثانية`) + (v.length ? ` · أعلى المحور ${Math.round(Math.max(20, ...v) * 1.15)} ms` : '');
  const s = m.series || [], W = 330, H = 90;
  const max = Math.max(20, ...v) * 1.15, X = i => (i / 59) * W, Y = x => H - 4 - (x / max) * (H - 12);
  let g = `<g class="grid" stroke="#eef1f6"><line x1="0" y1="${H * .33}" x2="${W}" y2="${H * .33}"/><line x1="0" y1="${H * .66}" x2="${W}" y2="${H * .66}"/></g>`;
  let d = '', pen = false;
  s.forEach(([i, x]) => { if (x == null) { pen = false; g += `<line x1="${X(i)}" y1="0" x2="${X(i)}" y2="${H}" stroke="#ef4444" stroke-width="2" stroke-opacity=".55" vector-effect="non-scaling-stroke"/>`; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1); pen = true; });
  if (d) g += `<path d="${d}" fill="none" stroke="#2b6cff" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  $('#monChart').innerHTML = g;
}

/* ================= النتيجة ================= */
function evaluate(r) {
  const bd = num(r.bloatDown) ? r.bloatDown : null, bu = num(r.bloatUp) ? r.bloatUp : null;
  const b = Math.max(bd || 0, bu || 0);
  const j = num(r.jitter) ? r.jitter : 0;
  const k4 = r.down >= TH.k4.ex ? 3 : r.down >= TH.k4.ok ? 2 : 1;
  const V = TH.vid, vid = (r.down >= V.ex.d && r.up >= V.ex.u && r.ping <= V.ex.p && j <= V.ex.j) ? 3 : (r.down >= V.ok.d && r.up >= V.ok.u && r.ping <= V.ok.p) ? 2 : 1;
  const G = TH.game; let game = (r.ping <= G.ex.p && j <= G.ex.j && b <= G.ex.b && r.down >= G.ex.d) ? 3 : (r.ping <= G.ok.p && j <= G.ok.j && b <= G.ok.b && r.down >= G.ok.d) ? 2 : 1;
  if (bd == null && bu == null && game === 3) game = 2; // لم يُقَس Bufferbloat: لا نمنح «ممتاز» للألعاب
  const overall = Math.min(k4, vid, game);
  const adv = [];
  if (b > TH.bloat[1]) adv.push(`التأخير يرتفع كثيراً تحت الضغط (Bufferbloat +${Math.round(b)}ms). فعّل SQM أو QoS في الراوتر إن توفّر، وأوقف التحميلات أثناء اللعب.`);
  else if (b > TH.bloat[0]) adv.push(`التأخير يرتفع قليلاً تحت الضغط (Bufferbloat +${Math.round(b)}ms). فعّل SQM في الراوتر لتحسين الألعاب.`);
  if (j > TH.jit[1]) adv.push('التذبذب مرتفع؛ اقترب من الراوتر أو استخدم شبكة 5GHz.');
  if (r.ping > G.ok.p) adv.push('زمن الاستجابة مرتفع؛ قد تكون الشبكة مزدحمة الآن.');
  if (r.up < V.ex.u) adv.push('سرعة الرفع منخفضة وقد تؤثر على مكالمات الفيديو والبث المباشر.');
  if (r.down < TH.k4.ok) adv.push('سرعة التحميل لا تكفي لبث 4K بثبات.');
  if (num(r.stab) && r.stab > TH.stab[1]) adv.push('سرعة التحميل متذبذبة خلال الاختبار.');
  if (!adv.length) adv.push('لا توجد مشاكل ملحوظة في هذا الاختبار. مناسب للبث والمكالمات والألعاب.');
  const head = overall === 3 ? 'اتصالك سريع ومستقر' : overall === 2 ? 'اتصالك جيد للاستخدام اليومي' : 'اتصالك يحتاج إلى تحسين';
  return { k4, vid, game, overall, head, adv: adv.slice(0, 2).join(' ') };
}
function fmtWhen(t, long) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= day0) return 'اليوم · ' + time;
  if (t >= day0 - 864e5) return 'أمس · ' + time;
  return d.toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long' }) + (long ? ' · ' + time : '');
}
// الاتجاه مقارنة بالاختبار الأقدم الذي يليه مباشرة في السجل
function trend(cur, prev, key, lowerBetter) {
  if (!prev || !num(cur[key]) || !num(prev[key]) || prev[key] <= 0) return null;
  const pct = (cur[key] - prev[key]) / prev[key] * 100;
  const better = lowerBetter ? pct < 0 : pct > 0;
  if (Math.abs(pct) < 3) return { txt: '≈', cls: 'tr-eq', pct };
  return { txt: `${pct > 0 ? '↑' : '↓'}${Math.round(Math.abs(pct))}%`, cls: better ? 'tr-up' : 'tr-down', pct };
}
function renderResult() {
  const hist = loadHist();
  if (current && !hist.some(h => h.t === current.t)) current = null;
  if (!current && hist.length) current = hist[0];
  $('#noRes').classList.toggle('hidden', !!current);
  $('#resWrap').classList.toggle('hidden', !current);
  $('#shareBtn').classList.toggle('hidden', !current);
  $('#histHead').classList.toggle('hidden', !hist.length);
  $('#hist').classList.toggle('hidden', !hist.length);
  if (current) {
    const r = current, ev = evaluate(r), [gl, gc, col] = GRADE[ev.overall];
    $('#ringArc').setAttribute('stroke', col);
    $('#ringArc').setAttribute('stroke-dasharray', `${[0, 0.36, 0.66, 0.9][ev.overall] * 219.9} 220`);
    const rt = $('#ringTxt'); rt.textContent = gl; rt.className = gc;
    $('#rHead').textContent = ev.head; $('#rAdv').textContent = ev.adv;
    $('#rDown').textContent = fmtS(r.down); $('#rUp').textContent = fmtS(r.up); $('#rPing').textContent = fmtMs(r.ping); $('#rJit').textContent = fmtMs(r.jitter);
    [['#u4k', ev.k4], ['#uVid', ev.vid], ['#uGame', ev.game]].forEach(([s, g]) => { const e = $(s); e.textContent = GRADE[g][0]; e.className = GRADE[g][1]; });
    const prev = hist[hist.findIndex(h => h.t === r.t) + 1];
    const parts = [['التحميل', trend(r, prev, 'down')], ['الرفع', trend(r, prev, 'up')], ['الاستجابة', trend(r, prev, 'ping', true)]].filter(p => p[1]);
    $('#rCmp').classList.toggle('hidden', !parts.length);
    $('#rCmp').innerHTML = parts.length ? '<span>مقارنة بالاختبار السابق:</span>' + parts.map(([k, t]) => `<span>${k} <b class="${t.cls}">${ltr(t.txt)}</b></span>`).join('') : '';
    const used = (r.bytesDown || 0) + (r.bytesUp || 0);
    $('#rMeta').textContent = [fmtWhen(r.t, true), r.colo ? 'خادم ' + coloName(r.colo) : '', r.conn, MODES[r.mode] ? 'وضع ' + MODES[r.mode].name : '', used ? 'استهلاك ' + fmtMB(used) : ''].filter(Boolean).join(' · ');
    const dur = r.dur || 10;
    $('#rDur').textContent = r.tDown ? `التحميل ${ltr((r.tDown / 1000).toFixed(1))} ث · الرفع ${ltr((r.tUp / 1000).toFixed(1))} ث` : dur + ' ث لكل مرحلة';
    $('#resChart').innerHTML = chartSVG(r.sDown || [], r.sUp || [], 330, 120, dur);
    const pk = Math.max(0, ...(r.sDown || []).map(p => p[1]));
    $('#rPeak').textContent = pk ? 'الذروة ' + ltr(fmtS(pk) + ' Mbps') : '';
  }
  const list = showAll ? hist : hist.slice(0, 5);
  $('#showAll').textContent = showAll ? 'عرض أقل' : 'عرض الكل';
  $('#showAll').classList.toggle('hidden', hist.length <= 5);
  $('#hist').innerHTML = list.map(h => {
    const prev = hist[hist.indexOf(h) + 1], t = trend(h, prev, 'down');
    return `<button class="it${current && h.t === current.t ? ' sel' : ''}" data-t="${h.t}"><div class="badge">${h.conn === 'خلوي' ? '◎' : '⌁'}</div><div class="m"><div class="a">${h.conn ? esc(h.conn) + ' · ' : ''}${h.colo ? 'خادم ' + esc(COLO[h.colo] || h.colo) : 'اختبار'}${h.ipv ? ' · IPv' + h.ipv : ''}</div><div class="b">${fmtWhen(h.t)}${MODES[h.mode] ? ' · ' + MODES[h.mode].name : ''}</div></div><div class="r">${t ? `<span class="tr ${t.cls}">${t.txt}</span>` : ''}${fmtS(h.down)} ↓<small>${fmtS(h.up)} ↑ · ${fmtMs(h.ping)}ms</small></div></button>`;
  }).join('');
}
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; } }
function saveHist(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) { } }
function deleteCurrent() {
  if (!current || !confirm('حذف هذه النتيجة من السجل؟')) return;
  const t = current.t; saveHist(loadHist().filter(h => h.t !== t)); current = null;
  toast('تم حذف النتيجة'); renderResult(); window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#startBtn').textContent = loadHist().length ? 'إعادة الاختبار' : 'ابدأ الاختبار';
}

async function share() {
  if (!current) return;
  const r = current, ev = evaluate(r);
  const text = `نبض الشبكة — نتيجة اختبار الإنترنت\n` +
    `التحميل: ${fmtS(r.down)} Mbps\nالرفع: ${fmtS(r.up)} Mbps\nالاستجابة: ${fmtMs(r.ping)} ms · Jitter: ${fmtMs(r.jitter)} ms\n` +
    (num(r.bloatDown) ? `Bufferbloat: +${Math.round(Math.max(r.bloatDown, num(r.bloatUp) ? r.bloatUp : 0))} ms\n` : '') +
    `التقييم: ${GRADE[ev.overall][0]} · بث 4K ${GRADE[ev.k4][0]} · فيديو ${GRADE[ev.vid][0]} · ألعاب ${GRADE[ev.game][0]}\n` +
    `${fmtWhen(r.t, true)}${r.colo ? ' · خادم ' + coloName(r.colo) : ''}`;
  const url = location.href.split('#')[0];
  try {
    if (navigator.share) await navigator.share({ title: 'نبض الشبكة', text, url });
    else { await navigator.clipboard.writeText(text + '\n' + url); toast('تم نسخ النتيجة'); }
  } catch (e) { if (e && e.name !== 'AbortError') toast('تعذّرت المشاركة'); }
}

/* ================= التنقل والإعدادات ================= */
const VIEWS = { test: '#v-test', result: '#v-result', net: '#v-net', more: '#v-more' };
function go(name, anchor) {
  if (running && name !== 'test') return;
  Object.entries(VIEWS).forEach(([k, s]) => $(s).classList.toggle('on', k === name));
  document.querySelectorAll('.tab .ti').forEach(b => b.classList.toggle('on', b.dataset.go === name));
  if (name === 'result') renderResult();
  if (name === 'net') { renderNet(); if (!ipv) runIpCheck(); }
  if (anchor) setTimeout(() => document.getElementById(anchor).scrollIntoView({ behavior: 'smooth' }), 50); else window.scrollTo(0, 0);
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200); }
function renderSettings() {
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === settings.mode));
  const c = MODES[settings.mode];
  $('#modeTxt').textContent = settings.mode === 'eco'
    ? `مناسب لباقات الجوال: كل مرحلة من 4 إلى 8 ثوانٍ وتتوقف تلقائياً عندما تستقر السرعة، وبحد أقصى تقريبي ${fmtMB(c.capDown)} للتحميل و ${fmtMB(c.capUp)} للرفع (على الشبكات فائقة السرعة قد يتجاوزه لأننا نقيس ثانيتين على الأقل كي تبقى النتيجة صحيحة).`
    : settings.mode === 'normal'
      ? `10 ثوانٍ لكل مرحلة. أدق على الألياف الضوئية؛ قد يستهلك حتى ${fmtMB(c.capDown)} على الشبكات السريعة جداً.`
      : `15 ثانية لكل مرحلة. الأدق، لكنه قد يستهلك عدة غيغابايت على الشبكات فائقة السرعة.`;
  const up = (v, u) => ltr(v + (u ? ' ' + u : '')) + ' فأكثر', dn = (v, u) => ltr(v + (u ? ' ' + u : '')) + ' أو أقل';
  $('#thrTxt').innerHTML = `
    <p><b>بث 4K:</b> ممتاز عند تحميل ${up(TH.k4.ex, 'Mbps')}، وجيد عند ${up(TH.k4.ok, 'Mbps')}.</p>
    <p><b>مكالمات الفيديو:</b> ممتاز عند تحميل ${up(TH.vid.ex.d, 'Mbps')}، ورفع ${up(TH.vid.ex.u, 'Mbps')}، واستجابة ${dn(TH.vid.ex.p, 'ms')}. جيد عند تحميل ${up(TH.vid.ok.d, 'Mbps')}، ورفع ${up(TH.vid.ok.u, 'Mbps')}، واستجابة ${dn(TH.vid.ok.p, 'ms')}.</p>
    <p><b>الألعاب:</b> ممتاز عند استجابة ${dn(TH.game.ex.p, 'ms')}، و ${ltr('Jitter')} ${dn(TH.game.ex.j, 'ms')}، و ${ltr('Bufferbloat')} ${dn(TH.game.ex.b, 'ms')}. جيد عند استجابة ${dn(TH.game.ok.p, 'ms')}، و ${ltr('Jitter')} ${dn(TH.game.ok.j, 'ms')}، و ${ltr('Bufferbloat')} ${dn(TH.game.ok.b, 'ms')}.</p>
    <p><b>التقييم العام:</b> أدنى تقييم بين الاستخدامات الثلاثة.</p>`;
}

document.addEventListener('click', e => {
  if (e.target.closest('#eyeBtn')) { settings.showIp = !settings.showIp; saveSettings(); renderNet(); renderIp(); buzz(); return; }
  const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go, g.dataset.anchor); return; }
  const it = e.target.closest('#hist .it'); if (it) { current = loadHist().find(h => h.t === +it.dataset.t) || current; renderResult(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const d = e.target.closest('#modeSeg button'); if (d) { settings.mode = d.dataset.m; saveSettings(); renderSettings(); buzz(); }
});
$('#startBtn').addEventListener('click', runTest);
$('#stopBtn').addEventListener('click', () => running && running.cancel());
$('#shareBtn').addEventListener('click', share);
$('#delRec').addEventListener('click', deleteCurrent);
$('#showAll').addEventListener('click', () => { showAll = !showAll; renderResult(); });
$('#netRefresh').addEventListener('click', () => { $('#netInfo').innerHTML = '<div class="muted">جارٍ القراءة…</div>'; loadMeta(); runIpCheck(); });
$('#ipTestBtn').addEventListener('click', runIpCheck);
$('#monBtn').addEventListener('click', () => mon ? stopMonitor() : startMonitor());
$('#clearHist').addEventListener('click', () => { if (confirm('مسح كل نتائج السجل من هذا الجهاز؟')) { localStorage.removeItem(HIST_KEY); current = null; toast('تم مسح السجل'); $('#startBtn').textContent = 'ابدأ الاختبار'; } });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (running) { running.cancel(); toast('أُوقف الاختبار لأن التطبيق انتقل للخلفية'); }
  if (mon) stopMonitor();
});
window.addEventListener('online', () => loadMeta());
window.addEventListener('offline', () => { meta = null; renderServer(); });
// منع التكبير بالنقر المزدوج: عبر touch-action: manipulation في CSS (يدعمه Safari على iOS 13+)

// تلميح التثبيت على الآيفون (Safari فقط، خارج وضع التطبيق)
(() => {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && !localStorage.getItem('nabd.installHint')) $('#install').classList.remove('hidden');
  $('#installX').addEventListener('click', () => { $('#install').classList.add('hidden'); localStorage.setItem('nabd.installHint', '1'); });
})();

renderSettings(); renderQuality(null);
$('#liveChart').innerHTML = chartSVG([], [], 330, 56, 10);
if (loadHist().length) $('#startBtn').textContent = 'إعادة الاختبار';
$('#usage').textContent = `الوضع: ${MODES[settings.mode].name}`;
loadMeta();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));
// للاختبار الآلي فقط
window.__nabd = { runTest, startMonitor, stopMonitor, get running() { return !!running; }, get mon() { return mon; }, get current() { return current; }, get ipv() { return ipv; } };
