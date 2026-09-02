/* ==========================================================================
   Neureka - Monitor de Água

   Reads the static JSON emitted by sync_to_site.py and renders one card per
   meter plus a per-physical-room analysis section.

   Contract with the Python side:
     data/manifest.json           { generated_at, rooms: [ { room_key, label,
                                    temperature, has_data, last_reading,
                                    last_reading_at, last_sync,
                                    available_months: ["YYYY-MM", ...] } ] }
     data/<room>/<YYYY-MM>.json   [ { timestamp, reading }, ... ]
     data/<room>/daily.json       [ { date, session_count, banho_count,
                                     descarga_count, total_liters,
                                     avg_liters_per_banho,
                                     avg_liters_per_descarga }, ... ]

   available_months is the authoritative shard list. The frontend never probes
   for month files that may not exist.
   ========================================================================== */

'use strict';

const DATA_ROOT = 'data';

// A sync older than this marks the banner as stale. The Scheduled Task runs
// hourly, so three missed runs is a real signal that something is wrong.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

// Averages in the analysis section are computed over this many trailing days
// (counting only days that actually have data).
const TRAILING_DAYS = 7;

const COLORS = {
  quente: { line: '#fb923c', fill: 'rgba(251, 146, 60, 0.16)', bar: '#fb923c' },
  fria: { line: '#38bdf8', fill: 'rgba(56, 189, 248, 0.16)', bar: '#38bdf8' }
};

const GRID_COLOR = 'rgba(148, 163, 184, 0.10)';
const TICK_COLOR = '#7c8ea6';

/* ------------------------------------------------------------------ helpers */

/**
 * Build an element. Text is set via textContent, never innerHTML, so labels and
 * readings coming from JSON can never be interpreted as markup.
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Fetch JSON, returning null instead of throwing.
 * A single missing shard must not blank the whole dashboard.
 */
async function fetchJson(path) {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) {
      console.warn(`fetch ${path}: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn(`fetch ${path} failed:`, error);
    return null;
  }
}

/** "2026-08-31 15:05:48" and ISO strings both parse; Safari needs the T form. */
function parseStamp(text) {
  if (typeof text !== 'string') return null;
  const parsed = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(date) {
  return date.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function formatDayShort(isoDate) {
  const parsed = parseStamp(`${isoDate} 00:00:00`);
  if (!parsed) return isoDate;
  return parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/**
 * Rotulo do eixo X do grafico de leituras: dia E hora.
 *
 * Antes daqui o rotulo era so o dia. Com uma foto a cada 10 minutos, as ~50
 * leituras de um mesmo dia recebiam rotulos identicos, e o eixo nao dizia nada
 * sobre horario - dava para ver QUE houve leitura, nunca QUANDO. Um trecho sem
 * captura (placa sem energia, por exemplo) ficava indistinguivel de um trecho
 * de consumo zero: os dois viram linha reta.
 */
function formatStampShort(date) {
  return date.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).replace(',', '');
}

/** The physical room a meter belongs to: "banheiro_quente" -> "banheiro". */
function roomGroupOf(roomKey) {
  const index = roomKey.lastIndexOf('_');
  return index === -1 ? roomKey : roomKey.slice(0, index);
}

function titleCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ------------------------------------------------------------------- charts */

let chartsAvailable = true;

function baseScales(yTitle) {
  return {
    x: {
      grid: { color: GRID_COLOR, drawTicks: false },
      border: { display: false },
      ticks: { color: TICK_COLOR, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 14 }
    },
    y: {
      title: yTitle
        ? { display: true, text: yTitle, color: TICK_COLOR, font: { size: 10 } }
        : { display: false },
      grid: { color: GRID_COLOR, drawTicks: false },
      border: { display: false },
      ticks: { color: TICK_COLOR, font: { size: 10 }, padding: 6 }
    }
  };
}

const TOOLTIP_STYLE = {
  backgroundColor: '#0e141d',
  borderColor: '#2b3a4d',
  borderWidth: 1,
  titleColor: '#e8eef6',
  bodyColor: '#c7d3e1',
  padding: 10,
  displayColors: false
};

/** Cumulative reading over time for one meter. */
function renderReadingChart(canvas, points, temperature) {
  const palette = COLORS[temperature] || COLORS.fria;
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map((point) => point.date),
      datasets: [{
        data: points.map((point) => point.reading),
        borderColor: palette.line,
        backgroundColor: palette.fill,
        borderWidth: 2,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: palette.line
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP_STYLE,
          callbacks: {
            title: (items) => formatDateTime(points[items[0].dataIndex].at),
            label: (item) => `${item.parsed.y.toFixed(3)} m³`
          }
        }
      },
      scales: {
        ...baseScales('m³'),
        y: { ...baseScales('m³').y, beginAtZero: false }
      }
    }
  });
}

/** Banhos and descargas per day for one physical room. */
function renderSessionChart(canvas, labels, series) {
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((entry) => ({
        label: entry.label,
        data: entry.values,
        backgroundColor: entry.color,
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 26
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP_STYLE,
          displayColors: true,
          callbacks: { label: (item) => `${item.dataset.label}: ${item.parsed.y}` }
        }
      },
      scales: {
        ...baseScales('por dia'),
        y: {
          ...baseScales('por dia').y,
          beginAtZero: true,
          ticks: {
            ...baseScales('por dia').y.ticks,
            precision: 0,
            // Counts are integers; hide fractional gridline labels.
            callback: (value) => (Number.isInteger(value) ? value : '')
          }
        }
      }
    }
  });
}

/* -------------------------------------------------------------- meter cards */

function emptyCard(room) {
  const card = el('article', 'card card--empty');
  card.dataset.temp = room.temperature;

  const icon = el('div', 'empty__icon');
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round"><path d="M12 3.2c3.1 3.9 5.5 7 5.5 9.8a5.5 5.5 0 0 1-11 0' +
    'c0-2.8 2.4-5.9 5.5-9.8Z"/><path d="M4 20 20 4"/></svg>';

  card.append(icon);
  card.append(el('h3', 'card__title', room.label));
  card.append(el('span', `badge badge--empty`, 'sem medidor'));
  card.append(el('p', 'empty__text', 'Sem dados ainda — instale a câmera deste cômodo.'));
  return card;
}

function meterCard(room, points) {
  const card = el('article', 'card');
  card.dataset.temp = room.temperature;

  const head = el('div', 'card__head');
  const heading = el('div');
  heading.append(el('h3', 'card__title', room.label));
  const readAt = parseStamp(room.last_reading_at);
  heading.append(el('p', 'card__meta', readAt ? formatDateTime(readAt) : '—'));
  head.append(heading);
  head.append(el('span', `badge badge--${room.temperature}`, room.temperature));
  card.append(head);

  const tile = el('div', 'tile');
  tile.append(el('span', 'tile__value', Number(room.last_reading).toFixed(3)));
  tile.append(el('span', 'tile__unit', 'm³'));
  tile.append(el('span', 'tile__label', 'leitura atual'));
  card.append(tile);

  if (!points.length) {
    card.append(el('p', 'card__note', 'Histórico indisponível — nenhum arquivo mensal pôde ser lido.'));
    return card;
  }

  if (!chartsAvailable) {
    card.append(el('p', 'card__note', 'Gráfico indisponível: a biblioteca Chart.js não carregou.'));
    return card;
  }

  const wrap = el('div', 'chart-wrap');
  const canvas = el('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Leitura acumulada de ${room.label}`);
  wrap.append(canvas);
  card.append(wrap);

  const first = points[0];
  const last = points[points.length - 1];
  const consumed = ((last.reading - first.reading) * 1000).toFixed(0);
  card.append(el(
    'p', 'card__note',
    `${points.length} leituras válidas · ${consumed} L consumidos no período`
  ));

  renderReadingChart(canvas, points, room.temperature);
  return card;
}

/** Load and flatten every monthly shard the manifest declares for a room. */
async function loadHistory(room) {
  const months = Array.isArray(room.available_months) ? room.available_months : [];
  const shards = await Promise.all(
    months.map((month) => fetchJson(`${DATA_ROOT}/${room.room_key}/${month}.json`))
  );

  const points = [];
  for (const shard of shards) {
    if (!Array.isArray(shard)) continue;
    for (const entry of shard) {
      const at = parseStamp(entry && entry.timestamp);
      const reading = Number(entry && entry.reading);
      if (!at || !Number.isFinite(reading)) continue;
      points.push({ at, reading, date: formatStampShort(at) });
    }
  }
  points.sort((a, b) => a.at - b.at);
  return points;
}

/* ----------------------------------------------------------- analysis cards */

/**
 * Weighted trailing average litres per session.
 * daily.json stores a per-day average and a count, so the true total for a day
 * is avg * count; summing those recovers an exact weighted mean.
 */
function trailingAverage(days, avgKey, countKey) {
  let liters = 0;
  let count = 0;
  for (const day of days.slice(-TRAILING_DAYS)) {
    const dayCount = Number(day[countKey]) || 0;
    const dayAvg = Number(day[avgKey]) || 0;
    liters += dayAvg * dayCount;
    count += dayCount;
  }
  return count ? { average: liters / count, count } : null;
}

function statBlock(label, result, modifier, unit) {
  const stat = el('div', `stat ${modifier}`);
  stat.append(el('span', 'stat__label', label));

  const value = el('div', 'stat__value');
  if (result) {
    value.append(document.createTextNode(result.average.toFixed(1)));
    value.append(el('small', null, unit));
  } else {
    value.classList.add('stat__value--none');
    value.textContent = '—';
  }
  stat.append(value);
  return stat;
}

function analysisCard(group) {
  const { name, hot, cold } = group;
  const card = el('article', 'card');
  // Mixed rooms carry the hot accent; cold-only rooms (laundry) carry the cold one.
  card.dataset.temp = hot ? 'quente' : 'fria';

  const head = el('div', 'card__head');
  const heading = el('div');
  heading.append(el('h3', 'card__title', titleCase(name)));
  const meters = [hot && 'quente', cold && 'fria'].filter(Boolean).join(' + ');
  heading.append(el('p', 'card__meta', `medidores: ${meters}`));
  head.append(heading);
  card.append(head);

  const hotDays = hot ? hot.daily : [];
  const coldDays = cold ? cold.daily : [];

  const stats = el('div', 'stats');
  stats.append(statBlock(
    'Média por banho',
    hot ? trailingAverage(hotDays, 'avg_liters_per_banho', 'banho_count') : null,
    'stat--hot', 'L'
  ));
  stats.append(statBlock(
    'Média por descarga',
    cold ? trailingAverage(coldDays, 'avg_liters_per_descarga', 'descarga_count') : null,
    'stat--cold', 'L'
  ));
  card.append(stats);

  // Union of both meters' dates so the bars line up on a shared axis.
  const dates = [...new Set([...hotDays, ...coldDays].map((day) => day.date))].sort();
  const recent = dates.slice(-TRAILING_DAYS * 2);

  if (!recent.length) {
    card.append(el('p', 'card__note', 'Nenhuma sessão de uso detectada ainda.'));
    return card;
  }

  const legend = el('div', 'legend');
  const series = [];

  if (hot) {
    const byDate = new Map(hotDays.map((day) => [day.date, day]));
    series.push({
      label: 'Banhos',
      color: COLORS.quente.bar,
      values: recent.map((date) => (byDate.get(date)?.banho_count) ?? 0)
    });
    const item = el('span', 'legend__item');
    item.append(el('span', 'legend__swatch legend__swatch--hot'));
    item.append(document.createTextNode('Banhos (medidor quente)'));
    legend.append(item);
  }

  if (cold) {
    const byDate = new Map(coldDays.map((day) => [day.date, day]));
    series.push({
      label: 'Descargas',
      color: COLORS.fria.bar,
      values: recent.map((date) => (byDate.get(date)?.descarga_count) ?? 0)
    });
    const item = el('span', 'legend__item');
    item.append(el('span', 'legend__swatch legend__swatch--cold'));
    item.append(document.createTextNode('Descargas (medidor frio)'));
    legend.append(item);
  }

  card.append(legend);

  if (!chartsAvailable) {
    card.append(el('p', 'card__note', 'Gráfico indisponível: a biblioteca Chart.js não carregou.'));
    return card;
  }

  const wrap = el('div', 'chart-wrap chart-wrap--tall');
  const canvas = el('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Sessões por dia em ${name}`);
  wrap.append(canvas);
  card.append(wrap);

  renderSessionChart(canvas, recent.map(formatDayShort), series);
  return card;
}

/* --------------------------------------------------------------- the banner */

function updateBanner(rooms) {
  const banner = document.getElementById('sync-banner');
  const value = document.getElementById('sync-value');

  const stamps = rooms
    .map((room) => parseStamp(room.last_sync))
    .filter(Boolean)
    .sort((a, b) => b - a);

  if (!stamps.length) {
    banner.dataset.state = 'error';
    value.textContent = 'desconhecida';
    return;
  }

  const newest = stamps[0];
  const age = Date.now() - newest.getTime();
  banner.dataset.state = age > STALE_AFTER_MS ? 'stale' : 'ok';
  value.textContent = formatDateTime(newest);
  banner.title = age > STALE_AFTER_MS
    ? 'A última sincronização foi há mais de 3 horas.'
    : 'Sincronização recente.';
}

function showAlert(message) {
  const alert = document.getElementById('global-alert');
  alert.textContent = message;
  alert.hidden = false;
}

/* ---------------------------------------------------------------- bootstrap */

async function init() {
  if (typeof window.Chart === 'undefined') {
    chartsAvailable = false;
    showAlert('Chart.js não pôde ser carregado. Os valores continuam corretos, mas sem gráficos.');
  }

  const manifest = await fetchJson(`${DATA_ROOT}/manifest.json`);
  const meterGrid = document.getElementById('meter-grid');
  const analysisGrid = document.getElementById('analysis-grid');
  meterGrid.replaceChildren();
  analysisGrid.replaceChildren();

  if (!manifest || !Array.isArray(manifest.rooms)) {
    showAlert(
      'Não foi possível carregar data/manifest.json. Rode sync_to_site.py e sirva a pasta ' +
      'por HTTP (abrir o arquivo via file:// é bloqueado pelo navegador).'
    );
    document.getElementById('sync-banner').dataset.state = 'error';
    document.getElementById('sync-value').textContent = 'indisponível';
    return;
  }

  const rooms = manifest.rooms;
  updateBanner(rooms);

  // Every meter's history in parallel - one slow shard must not serialise the rest.
  const histories = await Promise.all(
    rooms.map((room) => (room.has_data ? loadHistory(room) : Promise.resolve([])))
  );

  rooms.forEach((room, index) => {
    const hasReading = room.has_data && Number.isFinite(Number(room.last_reading));
    meterGrid.append(hasReading ? meterCard(room, histories[index]) : emptyCard(room));
  });

  // Analysis is per physical room, pairing that room's hot and cold meters.
  const dailyByRoom = new Map();
  await Promise.all(rooms.filter((room) => room.has_data).map(async (room) => {
    const daily = await fetchJson(`${DATA_ROOT}/${room.room_key}/daily.json`);
    if (Array.isArray(daily)) dailyByRoom.set(room.room_key, daily);
  }));

  const groups = new Map();
  for (const room of rooms) {
    const daily = dailyByRoom.get(room.room_key);
    if (!daily) continue;
    const name = roomGroupOf(room.room_key);
    const group = groups.get(name) || { name, hot: null, cold: null };
    const member = { room, daily };
    if (room.temperature === 'quente') group.hot = member;
    else group.cold = member;
    groups.set(name, group);
  }

  if (!groups.size) {
    analysisGrid.append(el(
      'p', 'muted',
      'Nenhuma análise disponível ainda — é preciso ao menos um medidor com leituras válidas.'
    ));
    return;
  }

  for (const group of groups.values()) {
    analysisGrid.append(analysisCard(group));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error('falha ao inicializar o painel:', error);
    showAlert('Erro inesperado ao montar o painel. Veja o console do navegador.');
  });
});
