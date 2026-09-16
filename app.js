/* ==========================================================================
   Neureka - Monitor de Água

   Reads the static JSON emitted by sync_to_site.py and renders, for a period
   the user picks (one day, one week of the month, or the whole month):

     - one meter card per hidrometro, with the volume chart of that period
     - a forecast of where the month lands
     - per-room analysis with subtotals by week

   Contract with the Python side:
     data/manifest.json           { generated_at, rooms: [ { room_key, label,
                                    temperature, has_data, last_reading,
                                    last_reading_at, last_sync,
                                    available_months: ["YYYY-MM", ...] } ] }
     data/<room>/analysis.json    { span, coverage, volume, gaps, daily, hourly,
                                    hourly_by_day }

   ESTE ARQUIVO NAO CALCULA VOLUME. Ele so desenha o que o Python ja apurou.

   A primeira versao somava os litros aqui, a partir das leituras cruas do
   shard mensal. Parecia inofensivo e nao era: sem os guardas que moram no
   sync_to_site.py, a agua de uma lacuna de 10 horas caia inteira no dia em que
   a placa voltou, e o dia 15/09 da agua quente aparecia com 473 L em vez de
   59 L. Os guardas ficam num lugar so; aqui e so apresentacao.
   ========================================================================== */

'use strict';

const DATA_ROOT = 'data';

// A sync older than this marks the banner as stale. The Scheduled Task runs
// hourly, so three missed runs is a real signal that something is wrong.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

const COLORS = {
  quente: { line: '#fb923c', fill: 'rgba(251, 146, 60, 0.16)', bar: '#fb923c' },
  fria: { line: '#38bdf8', fill: 'rgba(56, 189, 248, 0.16)', bar: '#38bdf8' }
};

const GRID_COLOR = 'rgba(148, 163, 184, 0.10)';
const TICK_COLOR = '#7c8ea6';

/*
 * Dois medidores no manifest, um reloginho so.
 *
 * A lavanderia e a cozinha fria passam pelo MESMO hidrometro fisico, entao
 * mante-los como duas entradas separadas mostraria o mesmo volume duas vezes e
 * somaria errado no total. Aqui a lavanderia e dobrada dentro da cozinha fria e
 * o rotulo diz que a medicao cobre os dois comodos.
 *
 * O backend segue emitindo as duas pastas - a fusao e so de exibicao, entao no
 * dia em que forem dois medidores de verdade basta apagar este mapa.
 */
const MERGE_INTO = { lavanderia_fria: 'cozinha_fria' };
const MERGED_LABEL = { cozinha_fria: 'Cozinha + Lavanderia - Fria' };

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

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

function titleCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Litros em pt-BR, sem casa decimal - o hidrometro resolve 1 L. */
function formatLiters(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString('pt-BR');
}

/** "YYYY-MM" -> "Setembro 2026" */
function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** Local "YYYY-MM-DD" for a Date. toISOString() would shift by the timezone. */
function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysInMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

/** "2026-09" + 16 -> "2026-09-16" */
function isoOf(monthKey, day) {
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}

/**
 * As semanas do mes, na definicao de calendario simples: 1-7, 8-14, 15-21,
 * 22-28 e o resto.
 *
 * Nao e a semana ISO de proposito. O pedido e "semana 1 a 4, ou 5 se houver", e
 * a semana ISO nao da isso: ela comeca na segunda, atravessa a virada do mes e
 * produziria uma "semana 1" com tres dias de agosto dentro de setembro. Aqui
 * cada semana e um bloco fechado de dias DESTE mes, que e o que soma certo num
 * subtotal mensal.
 */
function weeksOf(monthKey) {
  const total = daysInMonth(monthKey);
  const weeks = [];
  for (let start = 1; start <= total; start += 7) {
    weeks.push({ index: weeks.length + 1, from: start, to: Math.min(start + 6, total) });
  }
  return weeks;
}

/** The physical room a meter belongs to: "banheiro_quente" -> "banheiro". */
function roomGroupOf(roomKey) {
  const index = roomKey.lastIndexOf('_');
  return index === -1 ? roomKey : roomKey.slice(0, index);
}

/* ------------------------------------------------- leitura dos numeros prontos

   Tudo aqui e consulta ao que o Python apurou. Nenhuma soma de leitura crua.
*/

/** Litros de um dia especifico, ja com lacuna descontada pelo backend. */
function litersOfDay(meter, monthKey, day) {
  const value = meter.daily.get(isoOf(monthKey, day));
  return Number.isFinite(value) ? value : 0;
}

/**
 * As 24 horas de um dia, prontas para virar barra.
 *
 * O backend guarda valores signed. Uma hora negativa e ruido da roda do
 * milesimo: a leitura cai um litro e a hora seguinte recupera. Barra negativa
 * nao diz nada a ninguem, entao aqui tem que virar zero - mas NAO com
 * Math.max(0, x).
 *
 * Simplesmente cortar em zero conta a recuperacao sem nunca contar a queda, e a
 * soma das 24 barras passa o total do dia: na serie real o dia 14/09 dava 187 L
 * de barras contra 164 L de dia. E o mesmo erro que o backend evita com deltas
 * signed, so que mudado de lugar.
 *
 * Carregando o deficit para a hora seguinte, a queda e a recuperacao se anulam
 * onde de fato aconteceram, nenhuma barra fica negativa e a soma continua sendo
 * a parte observada do dia.
 */
function hoursOfDay(meter, iso) {
  const row = meter.hourlyByDay[iso];
  if (!Array.isArray(row)) return new Array(24).fill(0);

  const total = row.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const alvo = Math.max(0, total);

  // Passada para a frente: cada queda empurra o deficit para a hora seguinte.
  const out = [];
  let carry = 0;
  for (const raw of row) {
    const value = (Number(raw) || 0) + carry;
    if (value < 0) {
      out.push(0);
      carry = value;
    } else {
      out.push(value);
      carry = 0;
    }
  }

  // Se o dia ACABA devendo, o deficit nao teve hora seguinte para absorver e
  // ficaria perdido - a soma das barras passaria o total. Foi o que aconteceu
  // com 15/09 da fria: 142 L de barras para 118 L de dia. O resto sai das
  // ultimas horas, de tras para frente, onde a agua mais recente estava.
  let sobra = out.reduce((a, b) => a + b, 0) - alvo;
  for (let i = out.length - 1; i >= 0 && sobra > 0; i -= 1) {
    const tira = Math.min(out[i], sobra);
    out[i] -= tira;
    sobra -= tira;
  }

  return out;
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

/** Barras de litros. Usada pelo card do medidor e pelos subtotais por semana. */
function renderBarChart(canvas, labels, series, yTitle, maxBar) {
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
        maxBarThickness: maxBar || 22
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP_STYLE,
          displayColors: series.length > 1,
          callbacks: {
            label: (item) => `${item.dataset.label}: ${formatLiters(item.parsed.y)} L`
          }
        }
      },
      scales: {
        ...baseScales(yTitle),
        y: { ...baseScales(yTitle).y, beginAtZero: true }
      }
    }
  });
}

/** Litros por hora observada, por hora do dia. Horas sem observacao ficam vazias. */
function renderHourlyChart(canvas, series) {
  const labels = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}h`);
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
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
        x: { ...baseScales().x, ticks: { ...baseScales().x.ticks, autoSkipPadding: 4 } },
        y: { ...baseScales('L / hora observada').y, beginAtZero: true }
      }
    }
  });
}

/* --------------------------------------------------------------- app state */

const state = {
  months: [],        // ["2026-08", "2026-09"], mais novo por ultimo
  month: null,       // "2026-09"
  selection: null,   // { type: 'day'|'week'|'month', day?, week? }
  meters: [],        // [{ room, daily: Map, hourlyByDay: {}, hourly: [] }]
  emptyRooms: []
};

const charts = [];

function destroyCharts() {
  while (charts.length) {
    const chart = charts.pop();
    try { chart.destroy(); } catch (error) { /* chart ja morto, tudo bem */ }
  }
}

/** O intervalo de dias que a selecao cobre, dentro do mes escolhido. */
function selectedRange() {
  const total = daysInMonth(state.month);
  const sel = state.selection;
  if (sel.type === 'day') return { from: sel.day, to: sel.day };
  if (sel.type === 'week') {
    const week = weeksOf(state.month).find((w) => w.index === sel.week);
    return week ? { from: week.from, to: week.to } : { from: 1, to: total };
  }
  return { from: 1, to: total };
}

function selectionLabel() {
  const sel = state.selection;
  const [year, month] = state.month.split('-');
  if (sel.type === 'day') return `${String(sel.day).padStart(2, '0')}/${month}/${year}`;
  if (sel.type === 'week') {
    const range = selectedRange();
    return `semana ${sel.week} (${range.from}–${range.to}/${month})`;
  }
  return monthLabel(state.month);
}

/** Litros do medidor no periodo selecionado. */
function litersInSelection(meter) {
  const range = selectedRange();
  let sum = 0;
  for (let day = range.from; day <= range.to; day += 1) {
    sum += litersOfDay(meter, state.month, day);
  }
  return sum;
}

/* ------------------------------------------------------- seletor de periodo */

function renderMonthSelect() {
  const select = document.getElementById('month-select');
  select.replaceChildren();
  for (const month of [...state.months].reverse()) {
    const option = el('option', null, monthLabel(month));
    option.value = month;
    if (month === state.month) option.selected = true;
    select.append(option);
  }
  select.onchange = () => {
    state.month = select.value;
    // Trocar de mes zera a selecao: o dia 31 pode nao existir no mes novo.
    state.selection = { type: 'month' };
    renderPeriod();
    renderAll();
  };
}

function chip(text, active, title, onClick) {
  const button = el('button', 'chip', text);
  button.type = 'button';
  if (title) button.title = title;
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (active) button.classList.add('chip--on');
  button.onclick = onClick;
  return button;
}

/**
 * Os quadradinhos.
 *
 * Um dia sem nenhum litro medido em nenhum medidor recebe a classe chip--void.
 * Ele continua clicavel de proposito - ver um dia vazio e uma informacao, e
 * esconder o dia faria a grade pular numeros.
 */
function renderPeriod() {
  const dayGrid = document.getElementById('day-grid');
  const spanGrid = document.getElementById('span-grid');
  dayGrid.replaceChildren();
  spanGrid.replaceChildren();

  const total = daysInMonth(state.month);

  const withData = new Set();
  for (const meter of state.meters) {
    for (let day = 1; day <= total; day += 1) {
      if (litersOfDay(meter, state.month, day) > 0) withData.add(day);
    }
  }

  for (let day = 1; day <= total; day += 1) {
    const active = state.selection.type === 'day' && state.selection.day === day;
    const button = chip(String(day), active, null, () => {
      state.selection = { type: 'day', day };
      renderPeriod();
      renderAll();
    });
    if (!withData.has(day)) button.classList.add('chip--void');
    dayGrid.append(button);
  }

  for (const week of weeksOf(state.month)) {
    const active = state.selection.type === 'week' && state.selection.week === week.index;
    spanGrid.append(chip(
      `S${week.index}`,
      active,
      `Dias ${week.from} a ${week.to}`,
      () => {
        state.selection = { type: 'week', week: week.index };
        renderPeriod();
        renderAll();
      }
    ));
  }

  const monthChip = chip('Mês todo', state.selection.type === 'month', null, () => {
    state.selection = { type: 'month' };
    renderPeriod();
    renderAll();
  });
  monthChip.classList.add('chip--wide');
  spanGrid.append(monthChip);
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
  card.append(el('span', 'badge badge--empty', 'sem medidor'));
  card.append(el('p', 'empty__text', 'Sem dados ainda — instale a câmera deste cômodo.'));
  return card;
}

function meterCard(meter) {
  const { room } = meter;
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

  const liters = litersInSelection(meter);
  const consumo = el('p', 'card__period');
  consumo.append(el('strong', null, `${formatLiters(liters)} L`));
  consumo.append(document.createTextNode(` em ${selectionLabel()}`));
  card.append(consumo);

  if (!chartsAvailable) {
    card.append(el('p', 'card__note', 'Gráfico indisponível: a biblioteca Chart.js não carregou.'));
    return card;
  }

  const palette = COLORS[room.temperature] || COLORS.fria;
  let labels;
  let values;
  let yTitle;

  if (state.selection.type === 'day') {
    const iso = isoOf(state.month, state.selection.day);
    labels = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}h`);
    values = hoursOfDay(meter, iso);
    yTitle = 'litros / hora';
  } else {
    const range = selectedRange();
    labels = [];
    values = [];
    for (let day = range.from; day <= range.to; day += 1) {
      labels.push(String(day));
      values.push(litersOfDay(meter, state.month, day));
    }
    yTitle = 'litros / dia';
  }

  const wrap = el('div', 'chart-wrap');
  const canvas = el('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Consumo de ${room.label} em ${selectionLabel()}`);
  wrap.append(canvas);
  card.append(wrap);

  charts.push(renderBarChart(
    canvas, labels,
    [{ label: titleCase(room.temperature), color: palette.bar, values }],
    yTitle,
    state.selection.type === 'day' ? 14 : 22
  ));

  // Um dia sem hora nenhuma quase sempre e lacuna de captura, nao dia seco.
  if (state.selection.type === 'day' && values.every((v) => v === 0) && liters > 0) {
    card.append(el(
      'p', 'card__note',
      'Os litros deste dia passaram enquanto a câmera estava fora, então não dá ' +
      'para situá-los numa hora.'
    ));
  }

  return card;
}

/* ------------------------------------------------------------ previsao do mes

   Extrapolacao linear: o que passou por dia ate agora, vezes os dias do mes.

   E deliberadamente o metodo mais simples que existe, e o card diz isso na cara.
   Um modelo melhor precisaria de sazonalidade semanal (fim de semana gasta
   diferente de terca) e de varios meses de historico para estimar - com quatro
   dias de serie, qualquer coisa mais elaborada seria precisao fingida.

   O divisor conta os dias JA DECORRIDOS, nao os dias com dado. Se a placa ficou
   dois dias fora, esses dois dias tiveram consumo real que ninguem mediu, e
   dividir so pelos dias observados inflaria a media diaria.
*/

function forecastFor(meters) {
  const today = new Date();
  const total = daysInMonth(state.month);
  const isCurrentMonth = dayKey(today).slice(0, 7) === state.month;
  const elapsed = isCurrentMonth ? today.getDate() : total;

  let measured = 0;
  for (const meter of meters) {
    for (let day = 1; day <= total; day += 1) {
      measured += litersOfDay(meter, state.month, day);
    }
  }

  if (elapsed <= 0) return { measured, projected: null, elapsed, total, isCurrentMonth };
  const projected = isCurrentMonth ? (measured / elapsed) * total : measured;
  return { measured, projected, elapsed, total, isCurrentMonth };
}

function amountStat(label, value, modifier) {
  const stat = el('div', `stat ${modifier}`);
  stat.append(el('span', 'stat__label', label));
  const box = el('div', 'stat__value');
  const text = formatLiters(value);
  if (text === null) {
    box.classList.add('stat__value--none');
    box.textContent = '—';
  } else {
    box.append(document.createTextNode(text));
    box.append(el('small', null, 'L'));
  }
  stat.append(box);
  return stat;
}

function forecastCard(name, hotMeters, coldMeters) {
  const card = el('article', 'card');
  const hot = forecastFor(hotMeters);
  const cold = forecastFor(coldMeters);

  const head = el('div', 'card__head');
  const heading = el('div');
  heading.append(el('h3', 'card__title', name));
  heading.append(el('p', 'card__meta', monthLabel(state.month)));
  head.append(heading);
  card.append(head);

  const hotProjected = hotMeters.length ? hot.projected : null;
  const coldProjected = coldMeters.length ? cold.projected : null;
  const totalProjected = (hotProjected || 0) + (coldProjected || 0);

  const stats = el('div', 'stats');
  stats.append(amountStat('Previsto total', totalProjected || null, 'stat--total'));
  stats.append(amountStat('Quente', hotProjected, 'stat--hot'));
  stats.append(amountStat('Fria', coldProjected, 'stat--cold'));
  card.append(stats);

  const measured = hot.measured + cold.measured;
  card.append(el(
    'p', 'card__note',
    hot.isCurrentMonth
      ? `${formatLiters(measured)} L medidos em ${hot.elapsed} de ${hot.total} dias. ` +
        'A projeção repete essa média diária até o fim do mês.'
      : `${formatLiters(measured)} L no mês fechado — não há o que projetar.`
  ));

  return card;
}

/* ----------------------------------------------------------- analysis cards */

function analysisCard(group) {
  const { name, hot, cold } = group;
  const card = el('article', 'card');
  card.dataset.temp = hot ? 'quente' : 'fria';

  const members = [hot, cold].filter(Boolean);

  const head = el('div', 'card__head');
  const heading = el('div');
  heading.append(el('h3', 'card__title', titleCase(name)));
  const meters = [hot && 'quente', cold && 'fria'].filter(Boolean).join(' + ');
  heading.append(el('p', 'card__meta', `medidores: ${meters}`));
  head.append(heading);
  card.append(head);

  if (!members.length) {
    card.append(el('p', 'card__note', 'Ainda sem leituras suficientes para medir volume.'));
    return card;
  }

  /* ---- subtotais por semana ---- */

  const weeks = weeksOf(state.month);
  const labels = weeks.map((week) => `S${week.index}`);
  const series = [];
  const legend = el('div', 'legend');

  let hotTotal = null;
  let coldTotal = null;

  for (const member of members) {
    const isHot = member.room.temperature === 'quente';
    const values = weeks.map((week) => {
      let sum = 0;
      for (let day = week.from; day <= week.to; day += 1) {
        sum += litersOfDay(member, state.month, day);
      }
      return Math.round(sum);
    });
    const sum = values.reduce((a, b) => a + b, 0);
    if (isHot) hotTotal = sum; else coldTotal = sum;

    series.push({
      label: isHot ? 'Quente' : 'Fria',
      color: isHot ? COLORS.quente.bar : COLORS.fria.bar,
      values
    });

    const item = el('span', 'legend__item');
    item.append(el('span', `legend__swatch legend__swatch--${isHot ? 'hot' : 'cold'}`));
    item.append(document.createTextNode(isHot ? 'Quente (L/semana)' : 'Fria (L/semana)'));
    legend.append(item);
  }

  const stats = el('div', 'stats');
  stats.append(amountStat('Total no mês', (hotTotal || 0) + (coldTotal || 0), 'stat--total'));
  stats.append(amountStat('Quente', hotTotal, 'stat--hot'));
  stats.append(amountStat('Fria', coldTotal, 'stat--cold'));
  card.append(stats);

  card.append(el('h4', 'card__subtitle', 'Subtotais por semana'));
  card.append(legend);

  if (chartsAvailable) {
    const wrap = el('div', 'chart-wrap chart-wrap--narrow');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Litros por semana em ${name}`);
    wrap.append(canvas);
    card.append(wrap);
    charts.push(renderBarChart(canvas, labels, series, 'litros', 34));
  } else {
    card.append(el('p', 'card__note', 'Gráfico indisponível: a biblioteca Chart.js não carregou.'));
  }

  /* ---- perfil por hora do dia ---- */

  const hourSeries = members
    .map((member) => {
      if (!Array.isArray(member.hourly)) return null;
      const isHot = member.room.temperature === 'quente';
      return {
        label: isHot ? 'Quente' : 'Fria',
        color: isHot ? COLORS.quente.bar : COLORS.fria.bar,
        values: member.hourly.map((entry) => entry.liters_per_observed_hour)
      };
    })
    .filter((entry) => entry && entry.values.some((v) => v !== null && v !== undefined));

  if (hourSeries.length && chartsAvailable) {
    card.append(el('h4', 'card__subtitle', 'Perfil por hora do dia'));
    card.append(el(
      'p', 'card__note',
      'Litros por hora observada — corrige o viés das horas em que a câmera esteve fora.'
    ));
    const wrap = el('div', 'chart-wrap');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Consumo por hora do dia em ${name}`);
    wrap.append(canvas);
    card.append(wrap);
    charts.push(renderHourlyChart(canvas, hourSeries));
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

/* ------------------------------------------------------------------ render */

function groupsOfMeters() {
  const groups = new Map();
  for (const meter of state.meters) {
    const name = roomGroupOf(meter.room.room_key);
    const group = groups.get(name) || { name, hot: null, cold: null };
    if (meter.room.temperature === 'quente') group.hot = meter;
    else group.cold = meter;
    groups.set(name, group);
  }
  return groups;
}

function renderAll() {
  destroyCharts();

  const meterGrid = document.getElementById('meter-grid');
  const forecastGrid = document.getElementById('forecast-grid');
  const analysisGrid = document.getElementById('analysis-grid');
  meterGrid.replaceChildren();
  forecastGrid.replaceChildren();
  analysisGrid.replaceChildren();

  for (const meter of state.meters) meterGrid.append(meterCard(meter));
  for (const room of state.emptyRooms) meterGrid.append(emptyCard(room));

  const groups = groupsOfMeters();

  if (!groups.size) {
    forecastGrid.append(el('p', 'muted', 'Sem medidor com leitura — nada a projetar.'));
    analysisGrid.append(el('p', 'muted', 'Nenhuma análise disponível ainda.'));
    return;
  }

  for (const group of groups.values()) {
    forecastGrid.append(forecastCard(
      titleCase(group.name),
      group.hot ? [group.hot] : [],
      group.cold ? [group.cold] : []
    ));
  }

  // O total da casa so faz sentido com mais de um comodo medindo.
  if (groups.size > 1) {
    forecastGrid.append(forecastCard(
      'Casa inteira',
      state.meters.filter((m) => m.room.temperature === 'quente'),
      state.meters.filter((m) => m.room.temperature === 'fria')
    ));
  }

  for (const group of groups.values()) analysisGrid.append(analysisCard(group));
}

/* ---------------------------------------------------------------- bootstrap */

async function init() {
  if (typeof window.Chart === 'undefined') {
    chartsAvailable = false;
    showAlert('Chart.js não pôde ser carregado. Os valores continuam corretos, mas sem gráficos.');
  }

  const manifest = await fetchJson(`${DATA_ROOT}/manifest.json`);

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

  // Uma analise por medidor com dado. E a unica fonte de numero deste arquivo.
  const analyses = await Promise.all(rooms.map((room) => (
    room.has_data
      ? fetchJson(`${DATA_ROOT}/${room.room_key}/analysis.json`)
      : Promise.resolve(null)
  )));

  // Junta os medidores que sao o mesmo reloginho antes de montar qualquer card.
  const byKey = new Map();
  rooms.forEach((room, index) => {
    const target = MERGE_INTO[room.room_key] || room.room_key;
    const analysis = analyses[index];
    const existing = byKey.get(target);

    if (existing) {
      if (analysis && !existing.analysis) {
        existing.analysis = analysis;
        existing.room = {
          ...existing.room,
          has_data: true,
          last_reading: room.last_reading,
          last_reading_at: room.last_reading_at
        };
      }
      return;
    }

    const base = rooms.find((r) => r.room_key === target) || room;
    byKey.set(target, {
      room: {
        ...base,
        label: MERGED_LABEL[target] || base.label,
        has_data: base.has_data || room.has_data,
        last_reading: base.has_data ? base.last_reading : room.last_reading,
        last_reading_at: base.has_data ? base.last_reading_at : room.last_reading_at
      },
      analysis: base.room_key === room.room_key ? analysis : null
    });
  });

  state.meters = [];
  state.emptyRooms = [];

  for (const entry of byKey.values()) {
    const analysis = entry.analysis;
    const usable = analysis && Array.isArray(analysis.daily)
      && Number.isFinite(Number(entry.room.last_reading));

    if (!usable) {
      state.emptyRooms.push(entry.room);
      continue;
    }

    const daily = new Map();
    for (const row of analysis.daily) {
      if (typeof row.date === 'string') daily.set(row.date, Number(row.liters) || 0);
    }

    state.meters.push({
      room: entry.room,
      daily,
      hourlyByDay: analysis.hourly_by_day || {},
      hourly: analysis.hourly || []
    });
  }

  // Os meses vem das datas que o backend apurou, nao dos arquivos em disco.
  const months = new Set();
  for (const meter of state.meters) {
    for (const date of meter.daily.keys()) months.add(date.slice(0, 7));
  }
  state.months = [...months].sort();

  if (!state.months.length) {
    const meterGrid = document.getElementById('meter-grid');
    meterGrid.replaceChildren();
    for (const room of state.emptyRooms) meterGrid.append(emptyCard(room));
    document.getElementById('forecast-grid')
      .replaceChildren(el('p', 'muted', 'Sem leitura ainda — nada a projetar.'));
    document.getElementById('analysis-grid')
      .replaceChildren(el('p', 'muted', 'Nenhuma análise disponível ainda.'));
    return;
  }

  state.month = state.months[state.months.length - 1];
  state.selection = { type: 'month' };

  renderMonthSelect();
  renderPeriod();
  renderAll();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error('falha ao inicializar o painel:', error);
    showAlert('Erro inesperado ao montar o painel. Veja o console do navegador.');
  });
});
