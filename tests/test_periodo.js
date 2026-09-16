/*
 * Testa as funcoes de periodo do app.js contra os dados reais em data/.
 *
 * O app.js roda num contexto de vm com document/window fingidos, entao o que
 * esta sendo testado e O ARQUIVO QUE VAI AO AR, nao uma copia das funcoes que
 * poderia divergir dele.
 *
 * O que estes testes protegem, concretamente: a primeira versao do painel
 * somava os litros aqui no navegador, a partir das leituras cruas, e inflava o
 * dia 15/09 da agua quente de 59 para 473 L porque jogava a agua de uma lacuna
 * de 10 horas no dia em que a placa voltou. Hoje o app so consulta o que o
 * Python apurou, e o teste principal e justamente esse: nenhum numero exibido
 * pode ser maior do que o que o backend autorizou.
 *
 * Rodar:  node tests/test_periodo.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// O site publicado mora em /medicao - a raiz do repositorio e o webroot,
// entao o caminho do arquivo aqui e o caminho dele na URL.
const WEB = path.join(ROOT, 'medicao');

/* ------------------------------------------------ carrega o app.js de verdade */

const sandbox = {
  console,
  document: { addEventListener() {} },  // init() nunca roda sem o evento
  window: {},
  Chart: function Chart() {},
  Intl, Date, Math, Number, String, Array, Set, Map, JSON, RegExp,
  fetch: () => Promise.resolve(null)
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'), sandbox);

const {
  weeksOf, daysInMonth, isoOf, litersOfDay, hoursOfDay, readingsOfDay
} = sandbox;

/* ------------------------------------------------------------------ harness */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** Monta um "meter" igual ao que o init() monta, a partir do analysis.json. */
function meterFrom(roomKey) {
  const file = path.join(WEB, 'data', roomKey, 'analysis.json');
  if (!fs.existsSync(file)) return null;
  const analysis = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(analysis.daily)) return null;
  const daily = new Map();
  for (const row of analysis.daily) daily.set(row.date, Number(row.liters) || 0);
  return {
    room: { room_key: roomKey },
    daily,
    hourlyByDay: analysis.hourly_by_day || {},
    hourly: analysis.hourly || [],
    _analysis: analysis
  };
}

/* -------------------------------------------------------- semanas do mes */

console.log('\nweeksOf / daysInMonth / isoOf');

check('setembro 2026 tem 5 semanas', weeksOf('2026-09').length === 5,
  `achou ${weeksOf('2026-09').length}`);
check('fevereiro 2026 (28 dias) tem 4 semanas', weeksOf('2026-02').length === 4,
  `achou ${weeksOf('2026-02').length}`);
check('semana 1 e 1..7',
  weeksOf('2026-09')[0].from === 1 && weeksOf('2026-09')[0].to === 7);
check('ultima semana de setembro termina no dia 30',
  weeksOf('2026-09')[4].to === 30, `terminou em ${weeksOf('2026-09')[4].to}`);
check('as semanas cobrem o mes inteiro sem furo nem sobreposicao', (() => {
  for (const month of ['2026-01', '2026-02', '2026-04', '2026-09']) {
    const dias = new Set();
    for (const w of weeksOf(month)) {
      for (let d = w.from; d <= w.to; d += 1) {
        if (dias.has(d)) return false;
        dias.add(d);
      }
    }
    if (dias.size !== daysInMonth(month)) return false;
  }
  return true;
})());
check('fevereiro de ano bissexto tem 29 dias', daysInMonth('2028-02') === 29);
check('isoOf monta a data com zero a esquerda', isoOf('2026-09', 5) === '2026-09-05');

/* ------------------------------------------------- hoursOfDay tem 24 posicoes */

console.log('\nhoursOfDay');

const vazio = { daily: new Map(), hourlyByDay: {} };
check('dia sem registro devolve 24 zeros',
  hoursOfDay(vazio, '2026-09-01').length === 24
  && hoursOfDay(vazio, '2026-09-01').every((v) => v === 0));

check('hora negativa vira zero e o deficit vai para a hora seguinte', (() => {
  const m = { hourlyByDay: { '2026-09-01': [-3, 10, ...new Array(22).fill(0)] } };
  const h = hoursOfDay(m, '2026-09-01');
  // -3 vira 0 e leva o deficit adiante: 10 - 3 = 7. Nunca 10.
  return h[0] === 0 && h[1] === 7;
})());

check('o carry preserva a soma do dia', (() => {
  const bruto = [5, -4, 12, -1, 3, ...new Array(19).fill(0)];
  const m = { hourlyByDay: { '2026-09-01': bruto } };
  const soma = hoursOfDay(m, '2026-09-01').reduce((a, b) => a + b, 0);
  return soma === bruto.reduce((a, b) => a + b, 0);
})());

/* ------------------------------------------------ leituras de um dia so */

console.log('\nreadingsOfDay');

check('medidor sem pontos devolve lista vazia',
  readingsOfDay({}, '2026-09-16').length === 0);

check('filtra pelo dia local, nao por UTC', (() => {
  // 23:30 local de 15/09 vira 16/09 em UTC quando o fuso e negativo, e vira
  // 15/09 ainda em UTC quando e positivo. O filtro tem que olhar o dia LOCAL
  // nos dois casos, senao a ultima hora de cada dia migra para o dia seguinte.
  const m = { points: [
    { at: new Date(2026, 8, 15, 23, 30), reading: 100.000 },
    { at: new Date(2026, 8, 16, 0, 10), reading: 100.005 },
    { at: new Date(2026, 8, 16, 23, 50), reading: 100.010 }
  ] };
  return readingsOfDay(m, '2026-09-15').length === 1
    && readingsOfDay(m, '2026-09-16').length === 2;
})());

check('preserva a ordem cronologica', (() => {
  const m = { points: [
    { at: new Date(2026, 8, 16, 1, 0), reading: 1 },
    { at: new Date(2026, 8, 16, 7, 0), reading: 2 },
    { at: new Date(2026, 8, 16, 9, 0), reading: 3 }
  ] };
  const r = readingsOfDay(m, '2026-09-16');
  return r[0].at < r[1].at && r[1].at < r[2].at;
})());

/* ------------------------------------------------------ janela da previsao */

console.log('\nforecastWindow / formatM3');

/** Medidor de mentira com leitura nos dias listados. */
function medidorComDias(dias) {
  const points = [];
  for (const dia of dias) {
    points.push({ at: new Date(2026, 8, dia, 9, 0), reading: 100 + dia * 0.05 });
    points.push({ at: new Date(2026, 8, dia, 18, 0), reading: 100 + dia * 0.05 + 0.02 });
  }
  return { points, daily: new Map(), hourlyByDay: {} };
}

const { forecastWindow, formatM3 } = sandbox;

check('tres dias seguidos nao bastam',
  forecastWindow([medidorComDias([10, 11, 12])], '2026-09') === null);

check('quatro dias seguidos bastam', (() => {
  const w = forecastWindow([medidorComDias([10, 11, 12, 13])], '2026-09');
  return w && w.from === 10 && w.to === 13;
})());

check('quatro dias soltos nao bastam',
  forecastWindow([medidorComDias([1, 5, 9, 20])], '2026-09') === null);

check('pega a janela MAIS RECENTE quando ha duas', (() => {
  const w = forecastWindow([medidorComDias([1, 2, 3, 4, 20, 21, 22, 23])], '2026-09');
  return w && w.from === 20 && w.to === 23;
})());

check('a lacuna no meio e pulada', (() => {
  // Igual a serie real da agua quente: 1-3, buraco, 11-16.
  const w = forecastWindow([medidorComDias([1, 2, 3, 11, 12, 13, 14, 15, 16])], '2026-09');
  return w && w.from === 13 && w.to === 16;
})());

check('exige os quatro dias em TODOS os medidores do card', (() => {
  const completo = medidorComDias([10, 11, 12, 13]);
  const furado = medidorComDias([10, 11, 13]);   // falta o 12
  return forecastWindow([completo], '2026-09') !== null
    && forecastWindow([completo, furado], '2026-09') === null;
})());

check('sem medidor nenhum nao ha janela', forecastWindow([], '2026-09') === null);

check('formatM3 usa tres casas e virgula', formatM3(4822) === '4,822');
check('formatM3 devolve null para valor invalido', formatM3(null) === null);

/* --------------------------------------------- contra os dados de verdade */

for (const roomKey of ['banheiro_fria', 'banheiro_quente']) {
  const meter = meterFrom(roomKey);
  if (!meter) {
    console.log(`\n${roomKey}: sem analysis.json, pulando`);
    continue;
  }

  const month = '2026-09';
  console.log(`\n${roomKey} (${meter.daily.size} dias no analysis)`);

  check('o backend publicou hourly_by_day',
    Object.keys(meter.hourlyByDay).length > 0,
    'chave ausente -- rode o sync_to_site.py atualizado');

  // O teste do MEU codigo: exibir nao pode criar nem sumir litro. O que sai de
  // hoursOfDay tem que somar exatamente o que o backend mandou para aquele dia.
  const desvios = [];
  for (const [iso, bruto] of Object.entries(meter.hourlyByDay)) {
    const exibido = hoursOfDay(meter, iso).reduce((a, b) => a + b, 0);
    const original = bruto.reduce((a, b) => a + b, 0);
    // O carry so se perde quando o dia TERMINA negativo, e ai exibir 0 e o certo.
    const esperado = Math.max(0, original);
    if (Math.abs(exibido - esperado) > 0.5) {
      desvios.push(`${iso}: exibido=${exibido} esperado=${esperado}`);
    }
  }
  check('a exibicao preserva os litros que o backend mandou',
    desvios.length === 0, desvios.slice(0, 3).join(' | '));

  /*
   * Aviso, nao teste.
   *
   * Um dia em que as horas observadas passam o total do dia significa que a
   * SERIE DE ORIGEM se contradiz - quase sempre um misread que os guardas do
   * sync_to_site.py deixaram passar. Nao e defeito do painel e nao deve
   * reprovar o build; mas tambem nao pode ficar invisivel, porque e o numero
   * que vai aparecer na tela para alguem acreditar.
   */
  const suspeitos = [];
  for (let day = 1; day <= daysInMonth(month); day += 1) {
    const iso = isoOf(month, day);
    if (!meter.daily.has(iso)) continue;
    const doDia = litersOfDay(meter, month, day);
    const somaHoras = hoursOfDay(meter, iso).reduce((a, b) => a + b, 0);
    if (somaHoras > doDia + 2) suspeitos.push(`${iso}: horas=${somaHoras} dia=${doDia}`);
  }
  if (suspeitos.length) {
    console.log(`  AVISO  ${suspeitos.length} dia(s) com serie de origem inconsistente:`);
    for (const linha of suspeitos.slice(0, 4)) console.log(`         ${linha}`);
    console.log('         -> misread aceito pelo clean_readings, nao defeito do painel');
  }

  // As horas signed do backend telescopam para a parte observada do dia.
  const observado = meter._analysis.volume.observed_liters;
  let somaSigned = 0;
  for (const valores of Object.values(meter.hourlyByDay)) {
    for (const v of valores) somaSigned += v;
  }
  const tol = Object.keys(meter.hourlyByDay).length * 24 * 0.5 + 1;
  check('a soma signed de todas as horas bate com observed_liters',
    Math.abs(somaSigned - observado) <= tol,
    `horas=${somaSigned} observed=${observado} tolerancia=${tol.toFixed(0)}`);

  // Um dia qualquer com consumo tem que ter 24 posicoes.
  const comDado = Object.keys(meter.hourlyByDay)[0];
  if (comDado) {
    check(`${comDado} tem exatamente 24 horas`,
      meter.hourlyByDay[comDado].length === 24,
      `achou ${meter.hourlyByDay[comDado].length}`);
  }
}

/* -------------------------------------------------------------- resultado */

console.log(`\n${passed} passaram, ${failures.length} falharam`);
if (failures.length) {
  console.log('\nFALHAS:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
