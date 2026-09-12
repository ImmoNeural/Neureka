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

/*
 * The analysis section reports VOLUME, not events.
 *
 * A cumulative meter measures how much water passed exactly, even when it is
 * photographed only every ten minutes. What that sampling rate destroys is when
 * and how fast. Counting showers and flushes needs both, so those counts are not
 * shown here: on the real bathroom series the session layer placed 124 of 512
 * litres and implied 1.5-4.7 L/min for showers that physically run 8-12.
 *
 * Litres per day, litres per hour of day, and how much of the period was actually
 * observed are all things the meter genuinely knows. Those are what this renders,
 * and the coverage strip states the blind spot outright rather than letting an
 * unobserved stretch read as a quiet one.
 */

// How many trailing days the per-day volume chart shows.
const VOLUME_DAYS = 14;

// Below this much observation an hour's litres-per-hour is a small denominator
// amplifying noise, so the backend leaves it null and the chart leaves it blank.
const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}h`);

/** Litres per day, one grouped bar series per meter. */
function renderVolumeChart(canvas, labels, series) {
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
        maxBarThickness: 22
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
          callbacks: { label: (item) => `${item.dataset.label}: ${item.parsed.y} L` }
        }
      },
      scales: {
        ...baseScales('litros'),
        y: { ...baseScales('litros').y, beginAtZero: true }
      }
    }
  });
}

/** Litres per observed hour, by hour of day. Unobserved hours stay empty. */
function renderHourlyChart(canvas, series) {
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: HOUR_LABELS,
      datasets: series.map((entry) => ({
        label: entry.label,
        data: entry.values,
        backgroundColor: entry.color,
        borderRadius: 3,
        borderSkipped: false,
        maxBarThickness: 14
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
          callbacks: {
            label: (item) => (
              item.parsed.y === null
                ? `${item.dataset.label}: sem observação`
                : `${item.dataset.label}: ${item.parsed.y} L/h observada`
            )
          }
        }
      },
      scales: {
        ...baseScales('L / hora observada'),
        x: {
          ...baseScales().x,
          ticks: { ...baseScales().x.ticks, autoSkipPadding: 4 }
        },
        y: { ...baseScales('L / hora observada').y, beginAtZero: true }
      }
    }
  });
}

/** One figure with a caption. Value is pre-formatted; unit renders smaller. */
function volumeStat(label, value, modifier, unit) {
  const stat = el('div', `stat ${modifier}`);
  stat.append(el('span', 'stat__label', label));
  const box = el('div', 'stat__value');
  if (value === null || value === undefined) {
    box.classList.add('stat__value--none');
    box.textContent = '—';
  } else {
    box.append(document.createTextNode(String(value)));
    if (unit) box.append(el('small', null, unit));
  }
  stat.append(box);
  return stat;
}

/** Percentage in pt-BR: decimal comma, and no ",0" tail on round numbers. */
function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',')) + '%';
}

/** "8,7 h" / "8,7 dias" -- gaps run from an hour to over a week. */
function formatDuration(hours) {
  if (hours < 24) return `${hours.toFixed(1).replace('.', ',')} h`;
  return `${(hours / 24).toFixed(1).replace('.', ',')} dias`;
}

/** "03/09 02:04" from "2026-09-03 02:04:27". */
function formatGapStamp(text) {
  const stamp = parseStamp(text);
  if (!stamp) return text;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(stamp).replace(',', '');
}

/**
 * The coverage strip. This is the part that keeps the rest honest: it says how
 * much of the period had readings at all, and how many litres flowed while the
 * camera was blind. Those litres are real and counted in the total, but they
 * cannot be placed on a day or an hour, so every chart above is missing them.
 *
 * Two percentages, deliberately. A week away with the meters unplugged is not the
 * same failure as a board that browns out for two hours, and averaging them into
 * one number makes a holiday look like a broken pipeline. The headline figure
 * excludes planned absences and answers "is capture healthy"; the raw figure
 * answers "how much of the calendar has data".
 */
function coverageStrip(members) {
  const wrap = el('div', 'coverage');

  for (const member of members) {
    const { room, analysis } = member;
    const coverage = analysis.coverage;
    const volume = analysis.volume;
    if (!coverage || !volume) continue;

    const row = el('div', 'coverage__row');
    row.dataset.temp = room.temperature;

    const headline = Number.isFinite(coverage.observed_pct_excl_absence)
      ? coverage.observed_pct_excl_absence
      : coverage.observed_pct;

    const head = el('div', 'coverage__head');
    head.append(el('span', 'coverage__name', titleCase(room.temperature)));
    head.append(el('span', 'coverage__pct', `${formatPct(headline)} observado`));
    row.append(head);

    const track = el('div', 'coverage__track');
    const fill = el('div', 'coverage__fill');
    fill.style.width = `${Math.max(0, Math.min(100, headline))}%`;
    track.append(fill);
    row.append(track);

    const absenceMinutes = coverage.absence_minutes || 0;
    if (absenceMinutes > 0) {
      row.append(el(
        'p', 'coverage__note',
        `Fora de ausências programadas. Contando o calendário inteiro são ` +
        `${formatPct(coverage.observed_pct)}: ${formatDuration(absenceMinutes / 60)} com os ` +
        `medidores desligados, e ${volume.absence_liters} L passaram nesse período.`
      ));
    }

    const outageLiters = volume.outage_liters ?? volume.gap_liters;
    const outageCount = coverage.outage_count ?? coverage.gap_count;
    row.append(el(
      'p', 'coverage__note',
      outageCount
        ? `${outageCount} quedas de captura somando ` +
          `${formatDuration((coverage.outage_minutes || 0) / 60)}, com ${outageLiters} L ` +
          'que estão no total mas não podem ser situados em nenhum dia ou hora.'
        : 'Sem quedas de captura no período.'
    ));

    if (Array.isArray(analysis.gaps) && analysis.gaps.length) {
      const list = el('ul', 'gaps');
      for (const gap of analysis.gaps.slice(0, 4)) {
        const item = el('li', 'gaps__item');
        item.dataset.kind = gap.kind;
        item.append(el('span', 'gaps__dur', formatDuration(gap.hours)));
        item.append(el(
          'span', 'gaps__when',
          `${formatGapStamp(gap.from)} → ${formatGapStamp(gap.to)}`
        ));
        item.append(el(
          'span', 'gaps__tag',
          gap.kind === 'absence' ? 'desligado' : 'queda'
        ));
        item.append(el('span', 'gaps__liters', `${gap.liters} L`));
        list.append(item);
      }
      row.append(list);
    }

    wrap.append(row);
  }

  return wrap.childElementCount ? wrap : null;
}

function analysisCard(group) {
  const { name, hot, cold } = group;
  const card = el('article', 'card');
  card.dataset.temp = hot ? 'quente' : 'fria';

  const head = el('div', 'card__head');
  const heading = el('div');
  heading.append(el('h3', 'card__title', titleCase(name)));
  const meters = [hot && 'quente', cold && 'fria'].filter(Boolean).join(' + ');
  heading.append(el('p', 'card__meta', `medidores: ${meters}`));
  head.append(heading);
  card.append(head);

  const members = [hot, cold].filter((m) => m && m.analysis && m.analysis.volume);

  if (!members.length) {
    card.append(el('p', 'card__note', 'Ainda sem leituras suficientes para medir volume.'));
    return card;
  }

  const hotVolume = hot?.analysis?.volume?.total_liters ?? null;
  const coldVolume = cold?.analysis?.volume?.total_liters ?? null;
  const total = members.reduce((sum, m) => sum + m.analysis.volume.total_liters, 0);

  const stats = el('div', 'stats');
  stats.append(volumeStat('Total medido', total, 'stat--total', 'L'));
  stats.append(volumeStat('Quente', hotVolume, 'stat--hot', 'L'));
  stats.append(volumeStat('Fria', coldVolume, 'stat--cold', 'L'));
  card.append(stats);

  /* ---- litros por dia, quente x fria ---- */

  const dates = [...new Set(
    members.flatMap((m) => m.analysis.daily.map((day) => day.date))
  )].sort().slice(-VOLUME_DAYS);

  if (dates.length) {
    const legend = el('div', 'legend');
    const series = [];

    for (const member of members) {
      const isHot = member.room.temperature === 'quente';
      const byDate = new Map(member.analysis.daily.map((day) => [day.date, day]));
      series.push({
        label: isHot ? 'Quente' : 'Fria',
        color: isHot ? COLORS.quente.bar : COLORS.fria.bar,
        values: dates.map((date) => byDate.get(date)?.liters ?? 0)
      });
      const item = el('span', 'legend__item');
      item.append(el('span', `legend__swatch legend__swatch--${isHot ? 'hot' : 'cold'}`));
      item.append(document.createTextNode(isHot ? 'Quente (L/dia)' : 'Fria (L/dia)'));
      legend.append(item);
    }
    card.append(el('h4', 'card__subtitle', 'Litros por dia'));
    card.append(legend);

    if (chartsAvailable) {
      const wrap = el('div', 'chart-wrap chart-wrap--tall');
      const canvas = el('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Litros por dia em ${name}`);
      wrap.append(canvas);
      card.append(wrap);
      renderVolumeChart(canvas, dates.map(formatDayShort), series);
    } else {
      card.append(el('p', 'card__note', 'Gráfico indisponível: a biblioteca Chart.js não carregou.'));
    }
  }

  /* ---- perfil por hora do dia ---- */

  const hourSeries = members
    .filter((m) => Array.isArray(m.analysis.hourly))
    .map((member) => {
      const isHot = member.room.temperature === 'quente';
      return {
        label: isHot ? 'Quente' : 'Fria',
        color: isHot ? COLORS.quente.bar : COLORS.fria.bar,
        values: member.analysis.hourly.map((entry) => entry.liters_per_observed_hour)
      };
    })
    .filter((entry) => entry.values.some((value) => value !== null && value !== undefined));

  if (hourSeries.length) {
    card.append(el('h4', 'card__subtitle', 'Perfil por hora do dia'));
    card.append(el(
      'p', 'card__note',
      'Litros por hora observada — corrige o viés das horas em que a câmera esteve fora.'
    ));
    if (chartsAvailable) {
      const wrap = el('div', 'chart-wrap');
      const canvas = el('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Consumo por hora do dia em ${name}`);
      wrap.append(canvas);
      card.append(wrap);
      renderHourlyChart(canvas, hourSeries);
    }
  }

  /* ---- cobertura ---- */

  const strip = coverageStrip(members);
  if (strip) {
    card.append(el('h4', 'card__subtitle', 'Cobertura da captura'));
    card.append(strip);
  }

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
  const analysisByRoom = new Map();
  await Promise.all(rooms.filter((room) => room.has_data).map(async (room) => {
    const analysis = await fetchJson(`${DATA_ROOT}/${room.room_key}/analysis.json`);
    if (analysis && analysis.volume) analysisByRoom.set(room.room_key, analysis);
  }));

  const groups = new Map();
  for (const room of rooms) {
    const analysis = analysisByRoom.get(room.room_key);
    if (!analysis) continue;
    const name = roomGroupOf(room.room_key);
    const group = groups.get(name) || { name, hot: null, cold: null };
    const member = { room, analysis };
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
