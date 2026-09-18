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

/**
 * As leituras aceitas de UM dia, na ordem, para o grafico de escadinha.
 *
 * Estas sao as leituras que o Python ja limpou - o shard mensal e escrito a
 * partir de clean.readings, nao do Excel cru. Entao misread que os guardas
 * pegaram nao esta aqui.
 *
 * ATENCAO ao que este dado e e ao que nao e: aqui se EXIBE o que o relogio
 * marcava em cada foto. Nao se soma nada. Foi somar isto que inflou o painel na
 * primeira versao; a conta de litros continua vindo pronta do analysis.json.
 */
function readingsOfDay(meter, iso) {
  if (!Array.isArray(meter.points)) return [];
  return meter.points.filter((point) => dayKey(point.at) === iso);
}

/** As leituras do periodo selecionado - um dia, uma semana ou o mes inteiro. */
function readingsInSelection(meter) {
  if (!Array.isArray(meter.points)) return [];
  const range = selectedRange();
  const de = isoOf(state.month, range.from);
  const ate = isoOf(state.month, range.to);
  // Comparacao de string funciona porque YYYY-MM-DD ordena como data.
  return meter.points.filter((point) => {
    const dia = dayKey(point.at);
    return dia >= de && dia <= ate;
  });
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

/**
 * Leitura acumulada do relogio ao longo do periodo escolhido.
 *
 * Linha suave e preenchida, como era antes do seletor de periodo existir. A
 * versao em escadinha (stepped) foi tentada e descartada: era defensavel em
 * teoria - entre duas fotos ninguem sabe QUANDO a agua passou, e o degrau nao
 * fingia saber - mas ficou feia de olhar, e um painel que ninguem quer abrir
 * nao informa nada.
 *
 * O que muda com a selecao e a JANELA, nao o desenho: um dia, uma semana ou o
 * mes inteiro, sempre a mesma linha.
 *
 * Sem marcador fixo nos pontos, tambem como era antes. O ponto aparece no hover
 * e a interacao e por indice, entao clicar em qualquer altura da vertical pega
 * a leitura daquele instante - onPick recebe o ponto clicado.
 */
function renderReadingChart(canvas, points, temperature, onPick) {
  const palette = COLORS[temperature] || COLORS.fria;
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map((p) => p.hora),
      datasets: [{
        data: points.map((p) => p.reading),
        borderColor: palette.line,
        backgroundColor: palette.fill,
        borderWidth: 2,
        tension: 0.25,
        fill: true,
        pointRadius: 0,
        pointBackgroundColor: palette.line,
        pointHoverRadius: 4,
        pointHitRadius: 14
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (event, elements) => {
        if (elements && elements.length && typeof onPick === 'function') {
          onPick(points[elements[0].index]);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP_STYLE,
          callbacks: {
            title: (items) => formatDateTime(points[items[0].dataIndex].at),
            label: (item) => {
              const point = points[item.dataIndex];
              const passou = point.step > 0 ? `+${formatLiters(point.step)} L` : 'sem movimento';
              const linhas = [`${point.reading.toFixed(3)} m³  ·  ${passou}`];
              if (point.gapMinutes) {
                linhas.push(
                  `inclui ${(point.gapMinutes / 60).toFixed(1).replace('.', ',')} h sem foto`
                );
              }
              return linhas;
            }
          }
        }
      },
      scales: {
        ...baseScales('m³'),
        // beginAtZero seria fatal aqui: a faixa de um dia e de uns poucos
        // litros dentro de um numero de seis digitos, e a escadinha viraria
        // uma reta colada no topo.
        y: { ...baseScales('m³').y, beginAtZero: false }
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

/**
 * Onde o painel abre: no ultimo dia que tem leitura.
 *
 * Abrir no "mes todo" era tecnicamente defensavel e na pratica ruim - quem
 * chega quer ver o dia, e a escadinha de um mes inteiro e densa demais para
 * dizer alguma coisa. Cai no mes inteiro so quando nenhum dia tem leitura.
 */
function defaultSelectionFor(monthKey) {
  const total = daysInMonth(monthKey);
  for (let day = total; day >= 1; day -= 1) {
    for (const meter of state.meters) {
      if (readingsOfDay(meter, isoOf(monthKey, day)).length) {
        return { type: 'day', day };
      }
    }
  }
  return { type: 'month' };
}

/**
 * A versao curta da selecao, para o rotulo do bloco de consumo.
 *
 * O rotulo fica num canto de poucos pixels, e "semana 1 (1-7/09)" quebra em
 * duas linhas e empurra o numero. Aqui basta dizer QUAL periodo - o intervalo
 * exato ja esta no seletor logo acima e no eixo do grafico logo abaixo.
 */
function selectionShort() {
  const sel = state.selection;
  const [, mes] = state.month.split('-');
  if (sel.type === 'day') return `dia ${String(sel.day).padStart(2, '0')}/${mes}`;
  if (sel.type === 'week') return `semana ${sel.week}`;
  return 'no mês';
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
    // Trocar de mes nao pode carregar o dia escolhido: o 31 pode nao existir no
    // mes novo, e mesmo existindo pode nao ter leitura. Cai no ultimo dia com
    // dado do mes novo, que e onde o painel abre de qualquer jeito.
    state.selection = defaultSelectionFor(state.month);
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

  /* ---- os dois numeros que se le de relance ----

     Leitura atual e o que esta no relogio; consumo e o que passou no periodo
     escolhido. Sao grandezas diferentes e por isso ficam lado a lado com o
     mesmo peso: o primeiro e um marco, o segundo e a resposta para "gastei
     quanto hoje", que era o que faltava aparecer sem ter que ler o grafico. */

  const liters = litersInSelection(meter);

  const tiles = el('div', 'tiles');

  const atual = el('div', 'tile');
  atual.append(el('span', 'tile__value', Number(room.last_reading).toFixed(3)));
  atual.append(el('span', 'tile__unit', 'm³'));
  atual.append(el('span', 'tile__label', 'leitura atual'));
  tiles.append(atual);

  const gasto = el('div', 'tile');
  gasto.append(el('span', 'tile__value', formatLiters(liters)));
  gasto.append(el('span', 'tile__unit', 'L'));
  gasto.append(el('span', 'tile__label', selectionShort()));
  tiles.append(gasto);

  card.append(tiles);

  if (!chartsAvailable) {
    card.append(el('p', 'card__note', 'Gráfico indisponível: a biblioteca Chart.js não carregou.'));
    return card;
  }

  const palette = COLORS[room.temperature] || COLORS.fria;
  const wrap = el('div', 'chart-wrap');
  const canvas = el('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Consumo de ${room.label} em ${selectionLabel()}`);
  wrap.append(canvas);
  card.append(wrap);

  /* ---- a escadinha do relogio, sempre ----

     Card de medidor mostra LEITURA, nunca barra de volume. Barra de volume e o
     assunto da secao de Analises, e ter as duas coisas aqui so confundia: o
     painel abria no "mes todo" e o grafico de leitura nunca aparecia.

     Um dia, uma semana ou o mes: muda a janela, nao o tipo de grafico. */

  const brutos = readingsInSelection(meter);
  const umDia = state.selection.type === 'day';

  if (!brutos.length) {
    if (typeof wrap.remove === 'function') wrap.remove();
    card.append(el(
      'p', 'card__note',
      liters > 0
        ? 'A água deste período passou enquanto a câmera estava fora — não há ' +
          'leitura para desenhar.'
        : 'Nenhuma foto foi lida neste período.'
    ));
    return card;
  }

  // O salto de cada ponto: quanto o relogio andou desde a leitura anterior.
  // Negativo vira zero aqui porque isto e rotulo, nao soma - um recuo de ruido
  // nao e "consumo de -2 L", e simplesmente nao e movimento.
  const points = brutos.map((point, index) => {
    const anterior = index === 0 ? null : brutos[index - 1];
    const minutos = anterior ? (point.at - anterior.at) / 60000 : 0;
    return {
      at: point.at,
      reading: point.reading,
      // Num dia so a hora basta; numa semana ou mes o dia tem que aparecer,
      // senao o eixo repete "08:31" trinta vezes e nao diz de quando e.
      hora: umDia
        ? point.at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : point.at.toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
          }).replace(',', ''),
      step: anterior ? Math.max(0, (point.reading - anterior.reading) * 1000) : 0,
      // Um salto que atravessa uma lacuna de captura parece um banho enorme e
      // nao e: e a soma de tudo que passou enquanto ninguem olhava. As fotos
      // saem a cada 10 min, entao meia hora sem leitura ja e buraco.
      gapMinutes: minutos > 30 ? minutos : 0
    };
  });

  const readout = el('p', 'card__pick');
  readout.textContent = 'Clique no gráfico para ver data, hora e litros.';
  card.append(readout);

  charts.push(renderReadingChart(canvas, points, room.temperature, (point) => {
    readout.replaceChildren();
    readout.classList.add('card__pick--on');
    readout.append(el('strong', null, formatDateTime(point.at)));
    readout.append(document.createTextNode(` · ${point.reading.toFixed(3)} m³ · `));
    readout.append(el(
      'span',
      point.step > 0 ? 'card__pick--flow' : null,
      point.step > 0 ? `passaram ${formatLiters(point.step)} L` : 'sem movimento'
    ));
    if (point.gapMinutes) {
      readout.append(el(
        'span', 'card__pick--gap',
        ` (inclui ${(point.gapMinutes / 60).toFixed(1).replace('.', ',')} h sem foto)`
      ));
    }
  }));

  const comMovimento = points.filter((p) => p.step > 0).length;
  card.append(el(
    'p', 'card__note',
    `${points.length} leituras no período, ${comMovimento} com movimento do relógio. ` +
    'Clique em qualquer ponto para ver quanto passou desde a foto anterior.'
  ));

  return card;
}

/* ------------------------------------------------------------ previsao do mes

   Extrapolacao linear a partir de QUATRO DIAS SEGUIDOS de medicao.

   Por que uma janela fixa e continua, e nao o mes todo ate hoje. Dividir o
   acumulado pelos dias decorridos parece mais completo e e pior: os dias em que
   a placa ficou fora entram no divisor com consumo que ninguem mediu, e a media
   diaria despenca. Na serie real da agua quente, metade do mes esta em lacuna -
   a projecao por acumulado daria um numero que nao descreve nada.

   Quatro dias seguidos com foto sao quatro dias realmente observados, e e disso
   que sai uma media diaria que significa alguma coisa.

   Sem esses quatro dias, o card simplesmente NAO APARECE. Nao ha numero honesto
   a mostrar, e um numero ruim num painel vira decisao ruim depois.

   O que este metodo continua nao capturando: sazonalidade semanal. Uma janela
   caida num fim de semana projeta o mes inteiro como fim de semana. Corrigir
   isso precisa de meses de historico, que ainda nao existem.
*/

const FORECAST_DAYS = 4;

/**
 * O bloco mais recente de FORECAST_DAYS dias seguidos em que TODOS os medidores
 * do card tiveram leitura. Null quando nao existe.
 *
 * "Ter leitura" e ter foto lida naquele dia, nao aparecer no daily do backend:
 * um dia coberto so por uma lacuna aparece la com os litros da lacuna, e nao foi
 * observado.
 */
function forecastWindow(meters, monthKey) {
  if (!meters.length) return null;
  const total = daysInMonth(monthKey);

  const observado = (day) => {
    const iso = isoOf(monthKey, day);
    return meters.every((meter) => readingsOfDay(meter, iso).length > 0);
  };

  for (let fim = total; fim >= FORECAST_DAYS; fim -= 1) {
    let completo = true;
    for (let dia = fim - FORECAST_DAYS + 1; dia <= fim; dia += 1) {
      if (!observado(dia)) { completo = false; break; }
    }
    if (completo) return { from: fim - FORECAST_DAYS + 1, to: fim };
  }
  return null;
}

/** Litros que passaram por estes medidores dentro da janela. */
function litersInWindow(meters, monthKey, window) {
  let soma = 0;
  for (const meter of meters) {
    for (let dia = window.from; dia <= window.to; dia += 1) {
      soma += litersOfDay(meter, monthKey, dia);
    }
  }
  return soma;
}

/** Litros -> "1,234 m³". O hidrometro resolve litro, entao tres casas. */
function formatM3(liters) {
  if (liters === null || liters === undefined || !Number.isFinite(liters)) return null;
  return (liters / 1000).toFixed(3).replace('.', ',');
}

function amountStat(label, value, modifier, unit) {
  const stat = el('div', `stat ${modifier}`);
  stat.append(el('span', 'stat__label', label));
  const box = el('div', 'stat__value');
  const text = unit === 'm³' ? formatM3(value) : formatLiters(value);
  if (text === null) {
    box.classList.add('stat__value--none');
    box.textContent = '—';
  } else {
    box.append(document.createTextNode(text));
    box.append(el('small', null, unit || 'L'));
  }
  stat.append(box);
  return stat;
}

/** Devolve null quando nao ha quatro dias seguidos - ai nao se projeta nada. */
function forecastCard(name, hotMeters, coldMeters) {
  const todos = hotMeters.concat(coldMeters);
  const window = forecastWindow(todos, state.month);
  if (!window) return null;

  const dias = daysInMonth(state.month);
  const projetar = (meters) => {
    if (!meters.length) return null;
    return (litersInWindow(meters, state.month, window) / FORECAST_DAYS) * dias;
  };

  const quente = projetar(hotMeters);
  const fria = projetar(coldMeters);

  const card = el('article', 'card');
  const head = el('div', 'card__head');
  const heading = el('div');
  heading.append(el('h3', 'card__title', name));
  heading.append(el('p', 'card__meta', monthLabel(state.month)));
  head.append(heading);
  card.append(head);

  const stats = el('div', 'stats');
  stats.append(amountStat('Previsto total', (quente || 0) + (fria || 0), 'stat--total', 'm³'));
  stats.append(amountStat('Quente', quente, 'stat--hot', 'm³'));
  stats.append(amountStat('Fria', fria, 'stat--cold', 'm³'));
  card.append(stats);

  const media = litersInWindow(todos, state.month, window) / FORECAST_DAYS;
  const [, mes] = state.month.split('-');
  card.append(el(
    'p', 'card__note',
    `Base: dias ${window.from} a ${window.to}/${mes}, ${FORECAST_DAYS} dias seguidos ` +
    `com leitura — média de ${formatLiters(media)} L por dia, repetida pelos ` +
    `${dias} dias do mês.`
  ));

  return card;
}

/* ----------------------------------------------------------- analysis cards */

function analysisCard(group) {
  const { name, hot, cold } = group;
  const card = el('article', 'card');
  card.dataset.temp = hot ? 'quente' : 'fria';

  const members = [hot, cold].filter(Boolean);
  const pending = group.pending || [];

  const head = el('div', 'card__head');
  const heading = el('div');
  heading.append(el('h3', 'card__title', titleCase(name)));
  const meters = [hot && 'quente', cold && 'fria'].filter(Boolean).join(' + ');
  heading.append(el('p', 'card__meta', meters ? `medidores: ${meters}` : 'aguardando instalação'));
  head.append(heading);
  card.append(head);

  /*
   * Comodo que ainda nao mede nada aparece assim mesmo, com o bloco reservado.
   *
   * Some-lo seria mais limpo e diria menos: o painel existe para acompanhar a
   * casa inteira, e um comodo ausente da tela some tambem da cabeca de quem
   * olha. Com o bloco no lugar, da para ver de relance o que ja mede e o que
   * falta instalar - e no dia em que a camera subir, o card se preenche sozinho
   * sem mudanca nenhuma no codigo.
   */
  if (!members.length) {
    card.classList.add('card--waiting');

    const quaisMedidores = pending.map((room) => room.label).join(' · ');
    card.append(el(
      'p', 'card__note',
      quaisMedidores
        ? `Bloco reservado para ${quaisMedidores}. Assim que a câmera deste ` +
          'cômodo começar a enviar fotos, os subtotais por semana e o perfil por ' +
          'hora aparecem aqui.'
        : 'Ainda sem leituras suficientes para medir volume.'
    ));

    const stats = el('div', 'stats');
    stats.append(amountStat('Total no mês', null, 'stat--total'));
    stats.append(amountStat('Quente', null, 'stat--hot'));
    stats.append(amountStat('Fria', null, 'stat--cold'));
    card.append(stats);

    return card;
  }

  // Comodo que mede uma temperatura e espera a outra: diz qual falta, para o
  // total nao ser lido como se fosse a conta fechada do comodo.
  if (pending.length) {
    card.append(el(
      'p', 'card__note',
      `Falta instalar: ${pending.map((room) => room.label).join(' · ')}.`
    ));
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

/* --------------------------------------------------- leituras descartadas

   Um numero retirado da serie e uma decisao, e decisao invisivel nao pode ser
   contestada. Esta secao mostra o que o filtro tirou, quando, e por que - se
   algum dia ele errar, e aqui que da para ver.

   O arquivo vem da varredura diaria e pode nao existir (antes da primeira
   execucao, ou num deploy novo). Nesse caso a secao se explica em vez de
   mostrar erro.
*/

// Quantos descartes listar. O resto vira contagem: a lista existe para dar
// visibilidade, nao para ser um banco de dados navegavel.
const DESCARTES_VISIVEIS = 12;

function labelDoMedidor(roomKey) {
  const meter = state.meters.find((m) => m.room.room_key === roomKey);
  if (meter) return meter.room.label;
  const vazio = state.emptyRooms.find((r) => r.room_key === roomKey);
  return vazio ? vazio.label : roomKey;
}

function linhaDescarte(entrada, roomKey) {
  const item = el('li', 'descarte');

  const at = parseStamp(entrada.timestamp);
  item.append(el('span', 'descarte__quando', at ? formatDateTime(at) : entrada.timestamp));
  item.append(el('span', 'descarte__valor', `${Number(entrada.leitura).toFixed(3)} m³`));
  item.append(el('span', 'descarte__onde', labelDoMedidor(roomKey)));
  item.append(el('span', 'descarte__motivo', entrada.motivo));
  item.append(el('p', 'descarte__detalhe', entrada.detalhe));

  return item;
}

async function renderDiscards() {
  const box = document.getElementById('discard-box');
  if (!box) return;
  box.replaceChildren();

  const registro = await fetchJson(`${DATA_ROOT}/descartes.json`);

  if (!registro || !Array.isArray(registro.medidores)) {
    box.append(el(
      'p', 'muted',
      'O registro ainda não foi gerado — ele é escrito pela varredura das 11:59.'
    ));
    return;
  }

  // Achatado e ordenado por data, para "o que caiu hoje" ficar no topo
  // independentemente de qual medidor produziu.
  const todos = [];
  for (const medidor of registro.medidores) {
    for (const entrada of medidor.descartes || []) {
      todos.push({ entrada, roomKey: medidor.room_key });
    }
  }
  todos.sort((a, b) => String(b.entrada.timestamp).localeCompare(String(a.entrada.timestamp)));

  if (!todos.length) {
    box.append(el('p', 'muted', 'Nenhuma leitura descartada — o OCR não errou desde o início da série.'));
    return;
  }

  const resumo = el('p', 'descarte__resumo');
  resumo.append(el('strong', null, String(todos.length)));
  resumo.append(document.createTextNode(
    todos.length === 1 ? ' leitura descartada no histórico' : ' leituras descartadas no histórico'
  ));
  const geradoEm = parseStamp(registro.gerado_em);
  if (geradoEm) {
    resumo.append(document.createTextNode(` · revisado em ${formatDateTime(geradoEm)}`));
  }
  box.append(resumo);

  const lista = el('ul', 'descartes');
  for (const { entrada, roomKey } of todos.slice(0, DESCARTES_VISIVEIS)) {
    lista.append(linhaDescarte(entrada, roomKey));
  }
  box.append(lista);

  if (todos.length > DESCARTES_VISIVEIS) {
    box.append(el(
      'p', 'card__note',
      `Mostrando as ${DESCARTES_VISIVEIS} mais recentes. As outras ` +
      `${todos.length - DESCARTES_VISIVEIS} estão em data/descartes.json.`
    ));
  }

  // Subidas que passaram pelos guardas e ainda parecem grandes. Nao foram
  // removidas de proposito: um banho tambem produz subida grande, e essa
  // distincao e de quem conhece a casa.
  const conferir = registro.medidores.flatMap((m) =>
    (m.conferir || []).map((c) => ({ ...c, roomKey: m.room_key })));

  if (conferir.length) {
    box.append(el('h4', 'card__subtitle', 'Grandes, mas mantidas — vale conferir'));
    const lista2 = el('ul', 'descartes');
    for (const c of conferir.slice(0, 6)) {
      const item = el('li', 'descarte descarte--manter');
      const at = parseStamp(c.timestamp);
      item.append(el('span', 'descarte__quando', at ? formatDateTime(at) : c.timestamp));
      item.append(el('span', 'descarte__valor', `+${formatLiters(c.litros)} L`));
      item.append(el('span', 'descarte__onde', labelDoMedidor(c.roomKey)));
      item.append(el('p', 'descarte__detalhe', c.detalhe));
      lista2.append(item);
    }
    box.append(lista2);
  }
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

/**
 * Os comodos, agrupando quente e fria do mesmo lugar.
 *
 * Entram TODOS os comodos do manifest, inclusive os que ainda nao medem nada -
 * esses viram `pending` e a secao de Analises reserva o bloco deles. Os
 * medidores com dado vem primeiro para que o painel abra com o que ja funciona
 * no alto e o que falta instalar embaixo.
 */
function groupsOfMeters() {
  const groups = new Map();

  const encaixar = (room, meter) => {
    const name = roomGroupOf(room.room_key);
    const group = groups.get(name) || { name, hot: null, cold: null, pending: [] };
    if (meter) {
      if (room.temperature === 'quente') group.hot = meter;
      else group.cold = meter;
    } else {
      group.pending.push(room);
    }
    groups.set(name, group);
  };

  for (const meter of state.meters) encaixar(meter.room, meter);
  for (const room of state.emptyRooms) encaixar(room, null);

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

  // forecastCard devolve null quando faltam os quatro dias seguidos. Card que
  // nao pode ser honesto nao entra - por isso o filtro, e nao um append direto.
  const previsoes = [];
  for (const group of groups.values()) {
    previsoes.push(forecastCard(
      titleCase(group.name),
      group.hot ? [group.hot] : [],
      group.cold ? [group.cold] : []
    ));
  }

  // O total da casa so faz sentido com mais de um comodo medindo.
  if (groups.size > 1) {
    previsoes.push(forecastCard(
      'Casa inteira',
      state.meters.filter((m) => m.room.temperature === 'quente'),
      state.meters.filter((m) => m.room.temperature === 'fria')
    ));
  }

  const validas = previsoes.filter(Boolean);
  if (validas.length) {
    for (const card of validas) forecastGrid.append(card);
  } else {
    forecastGrid.append(el(
      'p', 'muted',
      `Ainda não há ${FORECAST_DAYS} dias seguidos com leitura em ` +
      `${monthLabel(state.month)} — sem base para projetar o mês.`
    ));
  }

  for (const group of groups.values()) analysisGrid.append(analysisCard(group));
}

/* ---------------------------------------------------------------- bootstrap */

/**
 * As leituras aceitas de um medidor, de todos os meses que o manifest declara.
 *
 * SO PARA DESENHAR. Cada ponto e o que o relogio marcava numa foto, e e isso
 * que a escadinha do dia mostra. Litro nenhum sai daqui - quem soma e o
 * sync_to_site.py, onde ficam os guardas de retrocesso, vazao e consenso.
 *
 * "analysis" aparece em available_months e nao e um mes; o filtro de formato
 * tira ele antes de virar caminho de arquivo.
 */
async function loadHistory(room) {
  const months = (Array.isArray(room.available_months) ? room.available_months : [])
    .filter((month) => /^\d{4}-\d{2}$/.test(month));

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
      points.push({ at, reading });
    }
  }
  points.sort((a, b) => a.at - b.at);
  return points;
}

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

  // Uma analise por medidor com dado. E a unica fonte de NUMERO deste arquivo.
  const analyses = await Promise.all(rooms.map((room) => (
    room.has_data
      ? fetchJson(`${DATA_ROOT}/${room.room_key}/analysis.json`)
      : Promise.resolve(null)
  )));

  // E os shards mensais, que sao a unica fonte de LEITURA - o que o relogio
  // marcava em cada foto, para a escadinha do dia. Nao entram em nenhuma soma.
  const histories = await Promise.all(rooms.map((room) => (
    room.has_data ? loadHistory(room) : Promise.resolve([])
  )));

  // Junta os medidores que sao o mesmo reloginho antes de montar qualquer card.
  const byKey = new Map();
  rooms.forEach((room, index) => {
    const target = MERGE_INTO[room.room_key] || room.room_key;
    const analysis = analyses[index];
    const existing = byKey.get(target);

    if (existing) {
      // Mesmo reloginho: as leituras dos dois room_key viram uma serie so.
      if (histories[index].length) {
        existing.points = existing.points
          .concat(histories[index])
          .sort((a, b) => a.at - b.at);
      }
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
      analysis: base.room_key === room.room_key ? analysis : null,
      points: histories[index].slice()
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
      hourly: analysis.hourly || [],
      points: entry.points || []
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
  state.selection = defaultSelectionFor(state.month);

  renderMonthSelect();
  renderPeriod();
  renderAll();

  // Depois do resto: o registro depende dos rotulos montados acima, e um
  // arquivo ausente nao pode atrasar o painel inteiro.
  renderDiscards().catch((error) => {
    console.warn('registro de descartes indisponivel:', error);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error('falha ao inicializar o painel:', error);
    showAlert('Erro inesperado ao montar o painel. Veja o console do navegador.');
  });
});
