/* Configuración */
const PROD_BASE   = 'https://Newtral-datos.github.io/monitor-carburantes-diario';
const IS_LOCAL    = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const BASE        = IS_LOCAL ? '' : PROD_BASE;
const PMTILES_URL = IS_LOCAL
  ? new URL('estaciones.pmtiles', location.href).href   // absoluta para el protocolo
  : `${PROD_BASE}/estaciones.pmtiles`;
const STATS_URL   = `${BASE}/stats.json`;

const INITIAL_CENTER = [-3.7, 40.3];
const INITIAL_ZOOM   = 5;

const FALLBACK_MIN    = 1.03;
const FALLBACK_MAX    = 1.89;
const FALLBACK_BREAKS = [1.42, 1.46, 1.50, 1.54, 1.58, 1.62, 1.66];

/* Paletas */
const GAS_COLORS    = ['#b8fff1','#88ffe5','#5df7d4','#3ceec4','#22ddb1','#09c39a','#019b7a','#00745b'];
const DIESEL_COLORS = ['#fff4c2','#ffe79a','#ffd76a','#ffca3a','#f3b61f','#d79a00','#a87200','#6f4d00'];

/* Paleta variación */
const VARIACION_COLORS = ['#1a9641','#a6d96a','#d9ef8b','#ffffbf','#fee08b','#fc8d59','#d73027'];
const VARIACION_BREAKS = [-0.12, -0.06, -0.02, 0.02, 0.06, 0.12];

/* Campos */
const FLD = {
  direccion:    'Dirección',
  horario:      'Horario',
  municipio:    'Municipio',
  provincia:    'Provincia',
  rotulo:       'Rótulo',
  gas95:        'Precio Gasolina 95 E5',
  diesel:       'Precio Gasoleo A',
  fechaDescarga:'FechaDescarga',
  ideess:       'IDEESS',
  deltaG95:     'delta_g95',
  deltaDiesel:  'delta_diesel'
};

/* Estado */
let DOMAIN_MIN  = FALLBACK_MIN;
let DOMAIN_MAX  = FALLBACK_MAX;
let BREAKS      = [...FALLBACK_BREAKS];
let currentFuel = 'g95';
let modoMapa    = 'precio';
const STATS_CACHE = { g95: null, diesel: null };

/* UI refs */
const tabs       = document.querySelectorAll('#fuel-tabs .tab');
const rangeEl    = document.getElementById('range');
const minLabel   = document.getElementById('min-label');
const maxLabel   = document.getElementById('max-label');
const btnVar     = document.getElementById('btn-variacion');

/* Mapa */
const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [] },
  center: INITIAL_CENTER, zoom: INITIAL_ZOOM, antialias: true
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

/* ─── Carga PMTiles ─── */
async function crearFuentePMTiles() {
  if (IS_LOCAL) {
    // Carga el archivo entero en memoria → no necesita Range requests
    const buf = await fetch('estaciones.pmtiles').then(r => r.arrayBuffer());
    const src = {
      getBytes: (off, len) => Promise.resolve({ data: buf.slice(off, off + len) }),
      getKey:   () => PMTILES_URL
    };
    return new pmtiles.PMTiles(src);
  }
  return new pmtiles.PMTiles(PMTILES_URL);
}

/* ─── Mapa base + estaciones ─── */
map.on('load', async () => {
  map.addSource('basemap', {
    type: 'raster',
    tiles: ['https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/{z}/{x}/{y}{r}.png'],
    tileSize: 256,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>'
  });
  map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' });

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile.bind(protocol));
  const p = await crearFuentePMTiles();
  protocol.add(p);

  map.addSource('stations', { type: 'vector', url: `pmtiles://${PMTILES_URL}` });
  map.addLayer({
    id: 'stations-circles',
    type: 'circle',
    source: 'stations',
    'source-layer': 'estaciones',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 6, 2, 8, 3.5, 10, 5],
      'circle-color': circleColorExpr(currentFuel),
      'circle-stroke-color': circleColorExpr(currentFuel),
      'circle-stroke-width': 0.6,
      'circle-opacity': 0.95
    }
  });

  ensureGlobalStats(currentFuel).then(() => {
    updateLegendTitle();
    syncSliderLegendAndStyle();
  });

  map.on('mousemove', 'stations-circles', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stations-circles', () => {
    map.getCanvas().style.cursor = '';
  });
  map.on('click', 'stations-circles', e => {
    if (!e.features?.length) return;
    showPopup(e.lngLat, popupHTML(e.features[0].properties || {}));
  });
});

/* ─── Leyenda ─── */
function buildLegend() {
  const sw  = document.getElementById('legend-swatches');
  const lab = document.getElementById('legend-labels');
  const leg = document.getElementById('legend');
  sw.innerHTML = ''; lab.innerHTML = '';
  leg.classList.toggle('is-variacion', modoMapa === 'variacion');

  if (modoMapa === 'variacion') {
    const bar = document.createElement('div');
    bar.className = 'legend-var-bar';
    bar.style.background = `linear-gradient(to right,${VARIACION_COLORS.join(',')})`;
    sw.appendChild(bar);
    [`≤ ${fmtV(VARIACION_BREAKS[0])}`, '0,00€', `≥ +${fmtV(VARIACION_BREAKS[5])}`].forEach(txt => {
      const s = document.createElement('span'); s.textContent = txt; lab.appendChild(s);
    });
  } else {
    const COLORS = currentFuel === 'g95' ? GAS_COLORS : DIESEL_COLORS;
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('div');
      el.className = 'sw'; el.style.background = COLORS[i]; sw.appendChild(el);
    }
    const labels = [DOMAIN_MIN, ...BREAKS, DOMAIN_MAX].filter(v => typeof v === 'number');
    const eight  = labels.length >= 9 ? labels.slice(0, 8) : labels;
    eight.forEach(v => {
      const s = document.createElement('span'); s.textContent = fmt(v); lab.appendChild(s);
    });
  }
}

function updateLegendTitle() {
  const t = document.getElementById('legend-title-text');
  if (!t) return;
  if (modoMapa === 'variacion')
    t.textContent = currentFuel === 'g95' ? 'Variación G95 (vs. inicio)' : 'Variación diésel (vs. inicio)';
  else
    t.textContent = currentFuel === 'g95' ? 'Precio de la gasolina' : 'Precio del diésel';
}

/* ─── Slider ─── */
noUiSlider.create(rangeEl, {
  start: [FALLBACK_MIN, FALLBACK_MAX], connect: true, step: 0.01,
  range: { min: FALLBACK_MIN, max: FALLBACK_MAX }
});
rangeEl.noUiSlider.on('update', ([a, b]) => { minLabel.textContent = fmt(+a); maxLabel.textContent = fmt(+b); });
rangeEl.noUiSlider.on('change', applyFilters);

/* ─── Tabs ─── */
tabs.forEach(btn => btn.addEventListener('click', async () => {
  if (btn.classList.contains('is-active')) return;
  tabs.forEach(b => { b.classList.remove('is-active'); b.setAttribute('aria-selected','false'); });
  btn.classList.add('is-active'); btn.setAttribute('aria-selected','true');
  currentFuel = btn.dataset.fuel;
  updateLegendTitle();
  await ensureGlobalStats(currentFuel);
  syncSliderLegendAndStyle();
}));

/* ─── Botón variación ─── */
if (btnVar) btnVar.addEventListener('click', () => {
  modoMapa = modoMapa === 'precio' ? 'variacion' : 'precio';
  btnVar.classList.toggle('is-active', modoMapa === 'variacion');
  updateLegendTitle(); buildLegend(); restyleLayer();
  modoMapa === 'variacion' ? map.setFilter('stations-circles', null) : applyFilters();
});

/* ─── Expresiones MapLibre ─── */
function priceExpr(f)  { return ['to-number', ['get', f], 0]; }
function activePriceExpr() { return currentFuel === 'g95' ? priceExpr(FLD.gas95) : priceExpr(FLD.diesel); }

function circleColorExpr(fuel) {
  const field  = fuel === 'g95' ? priceExpr(FLD.gas95) : priceExpr(FLD.diesel);
  const COLORS = fuel === 'g95' ? GAS_COLORS : DIESEL_COLORS;
  return ['step', field, COLORS[0],
    BREAKS[0], COLORS[1], BREAKS[1], COLORS[2], BREAKS[2], COLORS[3],
    BREAKS[3], COLORS[4], BREAKS[4], COLORS[5], BREAKS[5], COLORS[6], BREAKS[6], COLORS[7]
  ];
}

function circleColorExprVar(fuel) {
  const field = ['to-number', ['get', fuel === 'g95' ? FLD.deltaG95 : FLD.deltaDiesel], 0];
  const B = VARIACION_BREAKS;
  return ['step', field, VARIACION_COLORS[0],
    B[0], VARIACION_COLORS[1], B[1], VARIACION_COLORS[2], B[2], VARIACION_COLORS[3],
    B[3], VARIACION_COLORS[4], B[4], VARIACION_COLORS[5], B[5], VARIACION_COLORS[6]
  ];
}

/* ─── Filtros y estilos ─── */
function restyleLayer() {
  if (!map.getLayer('stations-circles')) return;
  const expr = modoMapa === 'variacion' ? circleColorExprVar(currentFuel) : circleColorExpr(currentFuel);
  map.setPaintProperty('stations-circles', 'circle-color', expr);
  map.setPaintProperty('stations-circles', 'circle-stroke-color', expr);
}
function applyFilters() {
  if (!map.getLayer('stations-circles')) return;
  if (modoMapa === 'variacion') { map.setFilter('stations-circles', null); return; }
  const [minV, maxV] = rangeEl.noUiSlider.get().map(Number);
  map.setFilter('stations-circles', ['all', ['>=', activePriceExpr(), minV], ['<=', activePriceExpr(), maxV]]);
}
function syncSliderLegendAndStyle() {
  rangeEl.noUiSlider.updateOptions({ range: { min: DOMAIN_MIN, max: DOMAIN_MAX }, start: [DOMAIN_MIN, DOMAIN_MAX] }, true);
  minLabel.textContent = fmt(DOMAIN_MIN); maxLabel.textContent = fmt(DOMAIN_MAX);
  buildLegend(); restyleLayer(); applyFilters();
}

/* ─── Popup ─── */
let popup;
let activeChart = null;

function showPopup(lngLat, html) {
  if (!popup) popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 8, maxWidth: '360px' });
  if (activeChart) { activeChart.destroy(); activeChart = null; }
  popup.setLngLat(lngLat).setHTML(html).addTo(map);
}
function hidePopup() { if (popup) popup.remove(); }

function popupHTML(p) {
  const ideess = p[FLD.ideess] || '';
  return `
    <div class="pp">
      <h3 class="pp-title">${p[FLD.rotulo] || '—'}</h3>
      <p class="pp-sub">${p[FLD.direccion] || '—'}</p>
      <div class="pp-row">
        <div><span class="pp-badge pp-badge--gas">Gasolina 95:</span><div class="pp-price">${fmtPrice(p[FLD.gas95])}</div></div>
        <div><span class="pp-badge pp-badge--diesel">Diésel:</span><div class="pp-price">${fmtPrice(p[FLD.diesel])}</div></div>
      </div>
      <div class="pp-footer">Actualización: ${p[FLD.fechaDescarga] || '—'}</div>
      ${ideess ? `<button class="pp-btn-evo" onclick="loadChart('${ideess}')">Ver evolución</button>
      <div class="popup-chart-wrap hidden" id="chart-wrap-${ideess}">
        <canvas id="chart-${ideess}"></canvas>
      </div>` : ''}
    </div>`;
}

async function loadChart(ideess) {
  const wrap = document.getElementById(`chart-wrap-${ideess}`);
  const btn  = wrap?.previousElementSibling;
  if (!wrap) return;

  if (activeChart) { activeChart.destroy(); activeChart = null; }

  wrap.classList.remove('hidden');
  if (btn) btn.style.display = 'none';

  let datos;
  try {
    const res = await fetch(`historico/${ideess}.json`);
    if (!res.ok) throw new Error('no data');
    datos = await res.json();
  } catch {
    wrap.innerHTML = '<p style="font-size:12px;color:#888;text-align:center;margin:8px 0">Sin datos históricos</p>';
    return;
  }

  const ctx = document.getElementById(`chart-${ideess}`);
  if (!ctx) return;

  activeChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: datos.fechas,
      datasets: [
        {
          label: 'Gasolina 95',
          data: datos.gasolina95,
          borderColor: '#01c49a',
          backgroundColor: 'rgba(1,196,154,0.08)',
          borderWidth: 2,
          pointRadius: datos.fechas.length < 15 ? 3 : 0,
          tension: 0.3,
          spanGaps: true
        },
        {
          label: 'Diésel',
          data: datos.gasoleo_a,
          borderColor: '#d79a00',
          backgroundColor: 'rgba(215,154,0,0.08)',
          borderWidth: 2,
          pointRadius: datos.fechas.length < 15 ? 3 : 0,
          tension: 0.3,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(3).replace('.',',') + ' €/l' : '—'}`
          }
        }
      },
      scales: {
        x: {
          ticks: { font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0 },
          grid: { display: false }
        },
        y: {
          ticks: {
            font: { size: 10 },
            callback: v => v.toFixed(2).replace('.',',') + '€'
          }
        }
      }
    }
  });
}

/* ─── Stats ─── */
async function ensureGlobalStats(fuel) {
  if (STATS_CACHE[fuel]) { setDomain(STATS_CACHE[fuel].min, STATS_CACHE[fuel].max, STATS_CACHE[fuel].breaks); return; }
  let min = FALLBACK_MIN, max = FALLBACK_MAX, breaks = [...FALLBACK_BREAKS];
  try {
    const res = await fetch(STATS_URL, { cache: 'no-cache' });
    if (res.ok) {
      const j = await res.json();
      const fn = fuel === 'g95' ? FLD.gas95 : FLD.diesel;
      if (j[fn]) { min = j[fn].min; max = j[fn].max; breaks = j[fn].breaks; }
    }
  } catch(e) {}
  STATS_CACHE[fuel] = { min, max, breaks };
  setDomain(min, max, breaks);
}

/* ─── Utilidades ─── */
function setDomain(min, max, breaks) { DOMAIN_MIN = round2(min); DOMAIN_MAX = round2(max); BREAKS = breaks.map(round2); }
function fmtPrice(v) { if (v == null || v === '') return '—'; const n = parseFloat(String(v).replace(',','.')); return Number.isFinite(n) ? n.toFixed(2).replace('.',',') + '€/l' : '—'; }
function fmt(n)  { return Number(n).toFixed(2).replace('.',',') + '€'; }
function fmtV(n) { return Number(n).toFixed(2).replace('.',',') + '€'; }
function round2(n) { return Math.round(n * 100) / 100; }
