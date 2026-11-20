/* نبض الشبكة — اختبار سرعة حقيقي عبر خوادم Cloudflare العامة (speed.cloudflare.com)
   كل الأرقام المعروضة مقاسة فعلياً في المتصفح. لا توجد قيم تقديرية أو وهمية. */
'use strict';

const CF = 'https://speed.cloudflare.com';
const STREAMS_DOWN = 6, STREAMS_UP = 6;
const DOWN_CHUNK = 25e6;          // حجم كل طلب تحميل (بايت)؛ يُكرر حتى تنتهي المدة
const UP_CHUNK = 8 * 1024 * 1024; // حجم كل طلب رفع
const WARMUP_MS = 2000;           // نستبعد أول ثانيتين (TCP slow-start)
const IDLE_PINGS = 20;
const SAMPLE_MS = 250;
const PROBE_TIMEOUT = 4000;      // مهلة قياس الاستجابة تحت الحمل
const HIST_KEY = 'nabd.history.v1', SET_KEY = 'nabd.settings.v1';

/* ================= معايير التقييم (موثّقة) =================
   الدرجات: 3 = ممتاز، 2 = جيد، 1 = ضعيف
   - بث 4K: التحميل ≥ 25 Mbps ممتاز (توصية Netflix/YouTube الشائعة لـ 4K)، ≥ 15 جيد، أقل = ضعيف
   - مكالمات الفيديو (HD جماعي): تحميل ≥ 10 ورفع ≥ 5 واستجابة ≤ 100ms و Jitter ≤ 30 = ممتاز
                                 تحميل ≥ 4 ورفع ≥ 2 واستجابة ≤ 150ms = جيد، غير ذلك ضعيف
   - الألعاب: استجابة ≤ 40 و Jitter ≤ 10 و Bufferbloat ≤ 30 و تحميل ≥ 10 = ممتاز
              استجابة ≤ 80 و Jitter ≤ 20 و Bufferbloat ≤ 100 و تحميل ≥ 3 = جيد، غير ذلك ضعيف
   - Jitter: ≤ 5 ممتاز، ≤ 15 جيد، ≤ 30 متوسط، أكثر = ضعيف
   - Bufferbloat (الزيادة في الاستجابة تحت الحمل): ≤ 30 ممتاز، ≤ 100 متوسط، أكثر = سيئ
   - ثبات السرعة (معامل اختلاف عينات 0.5 ث): ≤ 10% ممتاز، ≤ 25% جيد، أكثر = متذبذب
   - التقييم العام = أدنى درجة بين الاستخدامات الثلاثة */
const TH = {
  k4: { ex: 25, ok: 15 },
  vid: { ex: { d: 10, u: 5, p: 100, j: 30 }, ok: { d: 4, u: 2, p: 150 } },
  game: { ex: { p: 40, j: 10, b: 30, d: 10 }, ok: { p: 80, j: 20, b: 100, d: 3 } },
  jit: [5, 15, 30], bloat: [30, 100], stab: [10, 25]
};
const GRADE = { 3: ['ممتاز', 'gr', '#22c55e'], 2: ['جيد', 'am', '#f59e0b'], 1: ['ضعيف', 'rd', '#ef4444'] };

const COLO = { RUH: 'الرياض', JED: 'جدة', DMM: 'الدمام', BAH: 'البحرين', DXB: 'دبي', AUH: 'أبوظبي', DOH: 'الدوحة', KWI: 'الكويت', MCT: 'مسقط', AMM: 'عمّان', CAI: 'القاهرة', BGW: 'بغداد', FRA: 'فرانكفورت', MRS: 'مرسيليا', LHR: 'لندن', AMS: 'أمستردام', CDG: 'باريس', IST: 'إسطنبول', IAD: 'واشنطن', MAD: 'مدريد', MXP: 'ميلانو', BOM: 'مومباي', SIN: 'سنغافورة' };
const COUNTRY = { SA: 'السعودية', AE: 'الإمارات', KW: 'الكويت', QA: 'قطر', BH: 'البحرين', OM: 'عُمان', EG: 'مصر', JO: 'الأردن', US: 'الولايات المتحدة', GB: 'بريطانيا', DE: 'ألمانيا', FR: 'فرنسا', TR: 'تركيا' };

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const fmtS = v => !isFinite(v) ? '—' : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
const fmtMs = v => !isFinite(v) ? '—' : v >= 10 ? Math.round(v).toString() : v.toFixed(1);
const ltr = x => '\u2066' + x + '\u2069'; // عزل الأرقام والوحدات اللاتينية داخل النص العربي
const fmtMB = b => ltr(b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB');

let settings = Object.assign({ dur: 10 }, JSON.parse(localStorage.getItem(SET_KEY) || '{}'));
let meta = null, trace = null, running = null, current = null, showAll = false;

/* ================= الشبكة / الخادم ================= */
async function loadMeta() {
  // cdn-cgi/trace يسمح بالقراءة من أي موقع (CORS) ويعطي: ip، colo (رمز خادم Cloudflare)، loc (الدولة)، http، tls
  try {
    const t = await fetch(`${CF}/cdn-cgi/trace?r=${rnd()}`, { cache: 'no-store' }).then(r => r.text());
    trace = Object.fromEntries(t.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    meta = { ip: trace.ip, colo: trace.colo, country: trace.loc };
  } catch (e) { meta = null; }
  renderServer(); renderNet();
  return !!meta;
}
const coloName = c => c ? (COLO[c] ? `${COLO[c]} (${c})` : c) : '';
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
function renderNet() {
  const rows = [];
  const add = (k, v) => v && rows.push(`<div class="row"><span>${k}</span><b>${esc(v)}</b></div>`);
  if (!meta && !trace) { $('#netInfo').innerHTML = '<div class="muted">تعذّر قراءة بيانات الشبكة. تأكد من الاتصال ثم اضغط ↻.</div>'; return; }
  add('عنوان IP العام', meta && meta.ip);
  add('نوع العنوان', meta && meta.ip ? (meta.ip.includes(':') ? 'IPv6' : 'IPv4') : '');
  add('الدولة', meta && meta.country ? (COUNTRY[meta.country] || meta.country) : '');
  add('خادم القياس', `${coloName(meta && meta.colo)} · Cloudflare`);
  add('بروتوكول HTTP', trace && trace.http);
  add('تشفير الاتصال', trace && trace.tls);
  add('نوع الاتصال', connType());
  add('حالة المتصفح', navigator.onLine ? 'متصل' : 'غير متصل');
  $('#netInfo').innerHTML = rows.join('');
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ================= أدوات القياس ================= */
// قياس زمن الاستجابة لطلب صغير جداً (0 بايت). نستخدم Resource Timing عند توفره
// (من بداية إرسال الطلب حتى أول بايت) مطروحاً منه زمن معالجة الخادم المُعلن في Server-Timing.
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

function makeMeter(dur, onTick) {
  // يسجل عينات البايتات كل SAMPLE_MS ويحسب السرعة اللحظية (نافذة 1 ث)
  const m = { bytes: 0, samples: [], start: performance.now(), series: [] };
  m.timer = setInterval(() => {
    const t = performance.now() - m.start;
    m.samples.push({ t, b: m.bytes });
    const past = m.samples.find(s => s.t >= t - 1000) || m.samples[0];
    const dt = t - past.t;
    const live = dt > 0 ? (m.bytes - past.b) * 8 / dt / 1000 : 0; // Mbps
    if (t > 300) m.series.push([t / 1000, live]);
    onTick(live, Math.min(1, t / dur));
  }, SAMPLE_MS);
  m.finish = () => {
    clearInterval(m.timer);
    const t = performance.now() - m.start;
    m.samples.push({ t, b: m.bytes });
    const w = m.samples.find(s => s.t >= WARMUP_MS) || m.samples[0];
    const speed = t > w.t ? (m.bytes - w.b) * 8 / (t - w.t) / 1000 : 0;
    // ثبات السرعة: معامل الاختلاف لعينات كل 0.5 ث بعد فترة الإحماء
    const win = [];
    for (let i = 0; i < m.samples.length; i++) {
      const a = m.samples[i]; if (a.t < WARMUP_MS) continue;
      const b = m.samples.find(s => s.t >= a.t + 500); if (!b) break;
      win.push((b.b - a.b) * 8 / (b.t - a.t) / 1000); i += 1;
    }
    const mu = win.length ? mean(win) : 0;
    const cv = win.length > 2 && mu > 0 ? Math.sqrt(mean(win.map(x => (x - mu) ** 2))) / mu * 100 : NaN;
    return { speed, cv, bytes: m.bytes };
  };
  return m;
}

async function downloadPhase(ctx, dur, onTick) {
  const m = makeMeter(dur, onTick), ac = new AbortController(); ctx.aborts.add(ac);
  let stop = false;
  const worker = async () => {
    while (!stop) {
      try {
        const r = await fetch(`${CF}/__down?bytes=${DOWN_CHUNK}&r=${rnd()}`, { cache: 'no-store', signal: ac.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const rd = r.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; m.bytes += value.byteLength; }
      } catch (e) { if (stop || ctx.cancelled) return; ctx.errors++; if (ctx.errors > 30) throw e; await sleep(250); }
    }
  };
  const loaded = loadedPings(ctx, () => stop);
  const ws = Array.from({ length: STREAMS_DOWN }, worker);
  await Promise.race([sleep(dur), ctx.cancelP]);
  stop = true; ac.abort();
  await Promise.allSettled(ws);
  const res = m.finish(); res.loaded = await loaded; res.series = m.series;
  return res;
}

async function uploadPhase(ctx, dur, onTick) {
  const m = makeMeter(dur, onTick);
  const chunk = new Uint8Array(65536); crypto.getRandomValues(chunk);
  const blob = new Blob(Array(UP_CHUNK / 65536).fill(chunk));
  let stop = false; const xhrs = new Set();
  ctx.aborts.add({ abort: () => xhrs.forEach(x => x.abort()) });
  const worker = () => new Promise(resolve => {
    const go = () => {
      if (stop || ctx.cancelled) return resolve();
      const x = new XMLHttpRequest(); let last = 0; xhrs.add(x);
      x.open('POST', `${CF}/__up?r=${rnd()}`);
      x.upload.onprogress = e => { m.bytes += e.loaded - last; last = e.loaded; };
      x.onload = () => { xhrs.delete(x); if (last < UP_CHUNK) m.bytes += UP_CHUNK - last; go(); };
      x.onerror = () => { xhrs.delete(x); ctx.errors++; setTimeout(go, 250); };
      x.onabort = () => { xhrs.delete(x); resolve(); };
      x.send(blob);
    };
    go();
  });
  const loaded = loadedPings(ctx, () => stop);
  const ws = Array.from({ length: STREAMS_UP }, worker);
  await Promise.race([sleep(dur), ctx.cancelP]);
  stop = true; xhrs.forEach(x => x.abort());
  await Promise.race([Promise.allSettled(ws), sleep(1500)]);
  const res = m.finish(); res.loaded = await loaded; res.series = m.series;
  return res;
}

// قياس الاستجابة أثناء التحميل/الرفع (لحساب Bufferbloat)؛ يبدأ بعد الإحماء
async function loadedPings(ctx, isStopped) {
  const out = []; await sleep(WARMUP_MS - 500);
  while (!isStopped() && !ctx.cancelled) {
    const ac = new AbortController(); ctx.aborts.add(ac);
    let timedOut = false; const t0 = performance.now();
    const to = setTimeout(() => { timedOut = true; ac.abort(); }, PROBE_TIMEOUT);
    try { const v = await ping(ac.signal); if (!isStopped()) out.push(v); }
    catch (e) { if (timedOut && !isStopped()) out.push(performance.now() - t0); /* طلب لم يرد خلال المهلة = تأخير لا يقل عن المهلة */ }
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
  if (mode === 'ping') { n.textContent = fmtMs(v); u.textContent = 'ms'; arc.setAttribute('stroke-dasharray', `${Math.min(1, v / 200) * 471.24} 628.32`); $('#gMax').textContent = '200'; return; }
  u.textContent = 'Mbps';
  if (v > gaugeMax * 0.92) gaugeMax = SCALES.find(s => s > v * 1.1) || SCALES[SCALES.length - 1];
  $('#gMax').textContent = gaugeMax;
  n.textContent = fmtS(v);
  arc.setAttribute('stroke', mode === 'up' ? 'url(#gUp)' : 'url(#gDown)');
  arc.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, v / gaugeMax)) * 471.24} 628.32`);
}
function setTag(txt, cls) { const t = $('#gTag'); t.textContent = txt; t.className = 'tag' + (cls ? ' ' + cls : ''); }

function chartSVG(down, up, W, H, dur) {
  const all = [...down, ...up].map(p => p[1]);
  const max = Math.max(1, ...all) * 1.12;
  const X = t => (t / dur) * W, Y = v => H - 4 - (v / max) * (H - 10);
  const path = s => s.length ? s.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ') : '';
  let g = `<defs><linearGradient id="ga${H}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b6cff" stop-opacity=".28"/><stop offset="1" stop-color="#2b6cff" stop-opacity="0"/></linearGradient></defs>`;
  g += `<g stroke="#eef1f6"><line x1="0" y1="${H * .3}" x2="${W}" y2="${H * .3}"/><line x1="0" y1="${H * .62}" x2="${W}" y2="${H * .62}"/></g>`;
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
  if (!r) { ['qJit', 'qStab', 'qBd', 'qBu'].forEach(id => qCard(id, '—', '', '', 0, '#eef1f6')); return; }
  if (isFinite(r.jitter)) {
    const g = gradeJit(r.jitter);
    const [l, c, col] = g === 3 ? ['ممتاز', 'gr', '#22c55e'] : g === 2 ? ['جيد', 'gr', '#84cc16'] : g === 1.5 ? ['متوسط', 'am', '#f59e0b'] : ['ضعيف', 'rd', '#ef4444'];
    qCard('qJit', fmtMs(r.jitter) + ' ms', l, c, Math.max(8, 100 - r.jitter * 2.5), col);
  }
  if (isFinite(r.stab)) {
    const [l, c, col] = r.stab <= TH.stab[0] ? ['ممتاز', 'gr', '#22c55e'] : r.stab <= TH.stab[1] ? ['جيد', 'am', '#f59e0b'] : ['متذبذب', 'rd', '#ef4444'];
    qCard('qStab', '±' + Math.round(r.stab) + ' %', l, c, Math.max(8, 100 - r.stab * 2), col);
  } else if (r.down != null) qCard('qStab', '—', '', '', 0, '#eef1f6');
  const bl = (id, v) => {
    if (!isFinite(v)) return qCard(id, '—', 'غير متاح', 'muted', 0, '#eef1f6');
    const [l, c, col] = v <= TH.bloat[0] ? ['ممتاز', 'gr', '#22c55e'] : v <= TH.bloat[1] ? ['متوسط', 'am', '#f59e0b'] : ['سيئ', 'rd', '#ef4444'];
    qCard(id, '+' + Math.round(v) + ' ms', l, c, Math.max(8, 100 - v / 2), col);
  };
  if (r.bloatDown !== undefined) bl('qBd', r.bloatDown);
  if (r.bloatUp !== undefined) bl('qBu', r.bloatUp);
}

function setRunningUI(on) {
  $('#startBtn').classList.toggle('hidden', on);
  $('#stopBtn').classList.toggle('hidden', !on);
  document.querySelectorAll('.tab .ti').forEach(b => b.disabled = on && b.dataset.go !== 'test');
  document.querySelector('.tab').style.opacity = on ? .55 : 1;
}

async function runTest() {
  if (running) return;
  if (!navigator.onLine) return toast('لا يوجد اتصال بالإنترنت');
  const dur = settings.dur * 1000;
  let cancel; const ctx = { cancelled: false, errors: 0, aborts: new Set(), cancelP: new Promise(r => cancel = r) };
  ctx.cancel = () => { ctx.cancelled = true; ctx.aborts.forEach(a => a.abort()); cancel(); };
  running = ctx; setRunningUI(true);
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { }
  const r = { t: Date.now(), dur: settings.dur };
  const live = { down: [], up: [] };
  const drawLive = () => { $('#liveChart').innerHTML = chartSVG(live.down, live.up, 330, 56, settings.dur); };
  ['#vDown', '#vUp', '#vPing'].forEach(s => $(s).textContent = '—'); renderQuality(null); drawLive(); $('#usage').textContent = '';
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
    $('#vPing').textContent = fmtMs(r.ping); renderQuality(r);
    // 2) التحميل
    setTag('↓ جارٍ قياس التحميل'); setGauge(0, 'down');
    const d = await downloadPhase(ctx, dur, (v, p) => { setGauge(v, 'down'); $('#vDown').textContent = fmtS(v); live.down.push([p * settings.dur, v]); drawLive(); });
    if (ctx.cancelled) throw new Error('cancel');
    r.down = d.speed; r.stab = d.cv; r.bytesDown = d.bytes; r.sDown = live.down.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]);
    r.loadedDown = median(d.loaded); r.bloatDown = d.loaded.length ? Math.max(0, r.loadedDown - r.ping) : NaN;
    $('#vDown').textContent = fmtS(r.down); renderQuality(r);
    // 3) الرفع
    setTag('↑ جارٍ قياس الرفع', 'vio'); gaugeMax = 100; setGauge(0, 'up');
    const u = await uploadPhase(ctx, dur, (v, p) => { setGauge(v, 'up'); $('#vUp').textContent = fmtS(v); live.up.push([p * settings.dur, v]); drawLive(); });
    if (ctx.cancelled) throw new Error('cancel');
    r.up = u.speed; r.bytesUp = u.bytes; r.sUp = live.up.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]);
    r.loadedUp = median(u.loaded); r.bloatUp = u.loaded.length ? Math.max(0, r.loadedUp - r.ping) : NaN;
    $('#vUp').textContent = fmtS(r.up); renderQuality(r);
    if (!(r.down > 0) || !(r.up > 0)) throw new Error('zero');
    Object.assign(r, { colo: meta.colo, country: meta.country, conn: connType(), ipv: meta.ip && meta.ip.includes(':') ? 6 : 4 });
    setGauge(r.down, 'down'); setTag('✓ اكتمل الاختبار', 'gr');
    $('#usage').textContent = `استهلك الاختبار ${fmtMB(r.bytesDown + r.bytesUp)} من البيانات`;
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
    $('#startBtn').textContent = current ? 'إعادة الاختبار' : 'ابدأ الاختبار';
  }
}

/* ================= النتيجة ================= */
function evaluate(r) {
  const b = Math.max(isFinite(r.bloatDown) ? r.bloatDown : 0, isFinite(r.bloatUp) ? r.bloatUp : 0);
  const j = isFinite(r.jitter) ? r.jitter : 0;
  const k4 = r.down >= TH.k4.ex ? 3 : r.down >= TH.k4.ok ? 2 : 1;
  const V = TH.vid, vid = (r.down >= V.ex.d && r.up >= V.ex.u && r.ping <= V.ex.p && j <= V.ex.j) ? 3 : (r.down >= V.ok.d && r.up >= V.ok.u && r.ping <= V.ok.p) ? 2 : 1;
  const G = TH.game; let game = (r.ping <= G.ex.p && j <= G.ex.j && b <= G.ex.b && r.down >= G.ex.d) ? 3 : (r.ping <= G.ok.p && j <= G.ok.j && b <= G.ok.b && r.down >= G.ok.d) ? 2 : 1;
  if (!isFinite(r.bloatDown) && !isFinite(r.bloatUp) && game === 3) game = 2; // لم يُقَس Bufferbloat: لا نمنح «ممتاز» للألعاب
  const overall = Math.min(k4, vid, game);
  const adv = [];
  if (b > TH.bloat[1]) adv.push(`التأخير يرتفع كثيراً تحت الضغط (Bufferbloat +${Math.round(b)}ms). فعّل SQM أو QoS في الراوتر إن توفّر، وأوقف التحميلات أثناء اللعب.`);
  else if (b > TH.bloat[0]) adv.push(`التأخير يرتفع قليلاً تحت الضغط (Bufferbloat +${Math.round(b)}ms). فعّل SQM في الراوتر لتحسين الألعاب.`);
  if (j > TH.jit[1]) adv.push('التذبذب مرتفع؛ اقترب من الراوتر أو استخدم شبكة 5GHz.');
  if (r.ping > G.ok.p) adv.push('زمن الاستجابة مرتفع؛ قد تكون الشبكة مزدحمة الآن.');
  if (r.up < V.ex.u) adv.push('سرعة الرفع منخفضة وقد تؤثر على مكالمات الفيديو والبث المباشر.');
  if (r.down < TH.k4.ok) adv.push('سرعة التحميل لا تكفي لبث 4K بثبات.');
  if (isFinite(r.stab) && r.stab > TH.stab[1]) adv.push('سرعة التحميل متذبذبة خلال الاختبار.');
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
function renderResult() {
  const hist = loadHist();
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
    $('#rMeta').textContent = [fmtWhen(r.t, true), r.colo ? 'خادم ' + coloName(r.colo) : '', r.conn, (r.bytesDown + r.bytesUp) ? 'استهلاك ' + fmtMB(r.bytesDown + r.bytesUp) : ''].filter(Boolean).join(' · ');
    $('#rDur').textContent = r.dur + ' ث لكل مرحلة';
    $('#resChart').innerHTML = chartSVG(r.sDown || [], r.sUp || [], 330, 120, r.dur);
    const pk = Math.max(0, ...(r.sDown || []).map(p => p[1]));
    $('#rPeak').textContent = pk ? 'الذروة ' + ltr(fmtS(pk) + ' Mbps') : '';
  }
  const list = showAll ? hist : hist.slice(0, 5);
  $('#showAll').textContent = showAll ? 'عرض أقل' : 'عرض الكل';
  $('#showAll').classList.toggle('hidden', hist.length <= 5);
  $('#hist').innerHTML = list.map((h, i) => `<button class="it${current && h.t === current.t ? ' sel' : ''}" data-t="${h.t}"><div class="badge">${h.conn === 'خلوي' ? '◎' : '⌁'}</div><div class="m"><div class="a">${h.conn ? esc(h.conn) + ' · ' : ''}${h.colo ? 'خادم ' + esc(COLO[h.colo] || h.colo) : 'اختبار'}${h.ipv ? ' · IPv' + h.ipv : ''}</div><div class="b">${fmtWhen(h.t)}</div></div><div class="r">${fmtS(h.down)} ↓<small>${fmtS(h.up)} ↑ · ${fmtMs(h.ping)}ms</small></div></button>`).join('');
}
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; } }
function saveHist(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) { } }

async function share() {
  if (!current) return;
  const r = current, ev = evaluate(r);
  const text = `نبض الشبكة — نتيجة اختبار الإنترنت\n` +
    `التحميل: ${fmtS(r.down)} Mbps\nالرفع: ${fmtS(r.up)} Mbps\nالاستجابة: ${fmtMs(r.ping)} ms · Jitter: ${fmtMs(r.jitter)} ms\n` +
    (isFinite(r.bloatDown) ? `Bufferbloat: +${Math.round(Math.max(r.bloatDown, r.bloatUp || 0))} ms\n` : '') +
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
  if (name === 'net') renderNet();
  if (anchor) setTimeout(() => document.getElementById(anchor).scrollIntoView({ behavior: 'smooth' }), 50); else window.scrollTo(0, 0);
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200); }
function renderSettings() {
  document.querySelectorAll('#durSeg button').forEach(b => b.classList.toggle('on', +b.dataset.d === settings.dur));
  const up = (v, u) => ltr(v + (u ? ' ' + u : '')) + ' فأكثر', dn = (v, u) => ltr(v + (u ? ' ' + u : '')) + ' أو أقل';
  $('#thrTxt').innerHTML = `
    <p><b>بث 4K:</b> ممتاز عند تحميل ${up(TH.k4.ex, 'Mbps')}، وجيد عند ${up(TH.k4.ok, 'Mbps')}.</p>
    <p><b>مكالمات الفيديو:</b> ممتاز عند تحميل ${up(TH.vid.ex.d, 'Mbps')}، ورفع ${up(TH.vid.ex.u, 'Mbps')}، واستجابة ${dn(TH.vid.ex.p, 'ms')}. جيد عند تحميل ${up(TH.vid.ok.d, 'Mbps')}، ورفع ${up(TH.vid.ok.u, 'Mbps')}، واستجابة ${dn(TH.vid.ok.p, 'ms')}.</p>
    <p><b>الألعاب:</b> ممتاز عند استجابة ${dn(TH.game.ex.p, 'ms')}، و ${ltr('Jitter')} ${dn(TH.game.ex.j, 'ms')}، و ${ltr('Bufferbloat')} ${dn(TH.game.ex.b, 'ms')}. جيد عند استجابة ${dn(TH.game.ok.p, 'ms')}، و ${ltr('Jitter')} ${dn(TH.game.ok.j, 'ms')}، و ${ltr('Bufferbloat')} ${dn(TH.game.ok.b, 'ms')}.</p>
    <p><b>التقييم العام:</b> أدنى تقييم بين الاستخدامات الثلاثة.</p>`;
}

document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go, g.dataset.anchor); return; }
  const it = e.target.closest('#hist .it'); if (it) { current = loadHist().find(h => h.t === +it.dataset.t) || current; renderResult(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const d = e.target.closest('#durSeg button'); if (d) { settings.dur = +d.dataset.d; localStorage.setItem(SET_KEY, JSON.stringify(settings)); renderSettings(); }
});
$('#startBtn').addEventListener('click', runTest);
$('#stopBtn').addEventListener('click', () => running && running.cancel());
$('#shareBtn').addEventListener('click', share);
$('#showAll').addEventListener('click', () => { showAll = !showAll; renderResult(); });
$('#netRefresh').addEventListener('click', () => { $('#netInfo').innerHTML = '<div class="muted">جارٍ القراءة…</div>'; loadMeta(); });
$('#clearHist').addEventListener('click', () => { if (confirm('مسح كل نتائج السجل من هذا الجهاز؟')) { localStorage.removeItem(HIST_KEY); current = null; toast('تم مسح السجل'); $('#startBtn').textContent = 'ابدأ الاختبار'; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && running) { running.cancel(); toast('أُوقف الاختبار لأن التطبيق انتقل للخلفية'); } });
window.addEventListener('online', () => loadMeta());
window.addEventListener('offline', () => { meta = null; renderServer(); });

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
loadMeta();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));
// للاختبار الآلي فقط
window.__nabd = { runTest, get running() { return !!running; }, get current() { return current; }, ping };
