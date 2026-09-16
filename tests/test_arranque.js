/*
 * Roda o init() inteiro do app.js contra os arquivos reais de data/.
 *
 * Nao substitui abrir no navegador - Chart.js e layout ficam de fora. O que
 * este teste cobre e o caminho de arranque: ler o manifest, carregar as
 * analises, fundir a lavanderia na cozinha, derivar os meses, montar o seletor
 * e desenhar os tres blocos sem estourar. E ai que moram os erros de digitacao
 * em nome de campo, que so aparecem em runtime.
 *
 * Rodar:  node tests/test_arranque.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// O site publicado mora em /medicao - a raiz do repositorio e o webroot,
// entao o caminho do arquivo aqui e o caminho dele na URL.
const WEB = path.join(ROOT, 'medicao');

/* --------------------------------------------------------------- DOM de faz-de-conta */

const criados = [];

function novoNo(tag) {
  const no = {
    tagName: tag,
    className: '',
    children: [],
    dataset: {},
    style: {},
    _text: '',
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent || '').join('');
    },
    set innerHTML(v) { this._html = v; },
    append(...nos) {
      for (const n of nos) this.children.push(typeof n === 'object' ? n : { textContent: String(n) });
    },
    replaceChildren(...nos) { this.children.length = 0; this.append(...nos); },
    setAttribute(k, v) { this[k] = v; },
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      contains(c) { return this._set.has(c); }
    },
    onclick: null,
    onchange: null
  };
  no.classList = { _set: new Set(), add(...c) { c.forEach((x) => this._set.add(x)); },
                   contains(c) { return this._set.has(c); } };
  criados.push(no);
  return no;
}

const porId = new Map();
for (const id of ['sync-banner', 'sync-value', 'global-alert', 'month-select',
                  'day-grid', 'span-grid', 'meter-grid', 'forecast-grid',
                  'analysis-grid']) {
  porId.set(id, novoNo('div'));
}

const graficos = [];

let pronto = null;
const document_ = {
  addEventListener(evento, fn) { if (evento === 'DOMContentLoaded') pronto = fn; },
  getElementById: (id) => porId.get(id) || novoNo('div'),
  createElement: novoNo,
  createTextNode: (t) => ({ textContent: String(t), children: [] })
};

/* ---------------------------------------------- fetch que le do disco */

function fetchLocal(caminho) {
  const arquivo = path.join(WEB, caminho);
  if (!fs.existsSync(arquivo)) {
    return Promise.resolve({ ok: false, status: 404 });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(fs.readFileSync(arquivo, 'utf8')))
  });
}

/* ------------------------------------------------------------------- roda */

const sandbox = {
  console: { log: () => {}, warn: () => {}, error: console.error },
  document: document_,
  window: { Chart: function Chart() {} },
  // Guarda o que cada grafico pediu, para dar para afirmar "o card do medidor
  // desenhou linha" em vez de so "nao estourou".
  Chart: function Chart(canvas, config) {
    graficos.push(config);
    return { destroy() {} };
  },
  Intl, Date, Math, Number, String, Array, Set, Map, JSON, RegExp, Promise, Object,
  fetch: fetchLocal
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'), sandbox);

let passed = 0;
const failures = [];
function check(nome, cond, detalhe) {
  if (cond) { passed += 1; console.log(`  ok   ${nome}`); }
  else { failures.push(nome); console.log(`  FAIL ${nome}${detalhe ? ` -- ${detalhe}` : ''}`); }
}

check('o app registrou o DOMContentLoaded', typeof pronto === 'function');

pronto();

setTimeout(() => {
  // `const` de topo nao vira propriedade do contexto do vm - so as funcoes
  // declaradas viram. Entao o estado tem que ser lido avaliando o nome.
  const st = vm.runInContext('state', sandbox);

  console.log('\nestado depois do arranque');
  check('achou pelo menos um medidor com dado', st.meters.length > 0,
    `meters=${st.meters.length}`);
  check('derivou pelo menos um mes', st.months.length > 0,
    `months=${JSON.stringify(st.months)}`);
  check('escolheu o mes mais novo', st.month === st.months[st.months.length - 1]);
  // O painel abre num DIA, nao no mes todo: o card do medidor mostra a
  // escadinha de leitura, e um mes inteiro dela e denso demais para ler.
  check('abre num dia, nao no mes todo',
    st.selection && st.selection.type === 'day',
    JSON.stringify(st.selection));

  check('o dia de abertura tem leitura de verdade', (() => {
    if (!st.selection || st.selection.type !== 'day') return false;
    const iso = vm.runInContext('isoOf', sandbox)(st.month, st.selection.day);
    const lerDia = vm.runInContext('readingsOfDay', sandbox);
    return st.meters.some((m) => lerDia(m, iso).length > 0);
  })(), `dia ${st.selection && st.selection.day}`);

  console.log('\nfusao lavanderia + cozinha');
  const chaves = st.meters.map((m) => m.room.room_key).concat(
    st.emptyRooms.map((r) => r.room_key));
  check('lavanderia_fria nao aparece como medidor proprio',
    !chaves.includes('lavanderia_fria'), `chaves=${JSON.stringify(chaves)}`);
  const cozinha = st.emptyRooms.concat(st.meters.map((m) => m.room))
    .find((r) => r.room_key === 'cozinha_fria');
  check('cozinha fria leva o rotulo dos dois comodos',
    cozinha && cozinha.label === 'Cozinha + Lavanderia - Fria',
    cozinha ? cozinha.label : 'nao achou cozinha_fria');

  console.log('\nrenderizacao');
  check('o seletor de mes tem opcoes',
    porId.get('month-select').children.length === st.months.length,
    `${porId.get('month-select').children.length} opcoes`);
  const dias = porId.get('day-grid').children.length;
  check('a grade tem um quadradinho por dia do mes', dias === 30,
    `${dias} quadradinhos para setembro`);
  check('tem 5 semanas + o botao do mes',
    porId.get('span-grid').children.length === 6,
    `${porId.get('span-grid').children.length} botoes`);
  check('desenhou os cards dos medidores',
    porId.get('meter-grid').children.length === st.meters.length + st.emptyRooms.length);
  check('desenhou a previsao', porId.get('forecast-grid').children.length > 0);
  check('desenhou as analises', porId.get('analysis-grid').children.length > 0);

  /*
   * Analises tem UM bloco por comodo, inclusive os que ainda nao medem nada.
   * A cozinha (que cobre a lavanderia pelo mesmo reloginho) precisa do bloco
   * reservado desde ja, senao quem olha o painel esquece que ela existe.
   */
  const analises = porId.get('analysis-grid').children;
  const textos = analises.map((c) => c.textContent);

  check('ha um bloco de analise para cada comodo', analises.length === 2,
    `${analises.length} blocos: ${textos.map((t) => t.slice(0, 20)).join(' | ')}`);

  check('o banheiro aparece nas analises',
    textos.some((t) => t.includes('Banheiro')));

  check('a cozinha aparece mesmo sem dado',
    textos.some((t) => t.includes('Cozinha')),
    textos.join(' ~ ').slice(0, 160));

  check('o bloco da cozinha cita a lavanderia', (() => {
    const bloco = textos.find((t) => t.includes('Cozinha'));
    return bloco && bloco.includes('Lavanderia');
  })());

  check('a cozinha nao entra na previsao (nao ha o que projetar)',
    !porId.get('forecast-grid').children
      .some((c) => (c.textContent || '').includes('Cozinha')));
  check('nao mostrou alerta de erro', !porId.get('global-alert').textContent,
    porId.get('global-alert').textContent);

  console.log('\ntroca de periodo');
  const primeiroDia = porId.get('day-grid').children.find((c) => c.onclick);
  if (primeiroDia) {
    primeiroDia.onclick();
    check('clicar num dia muda a selecao', st.selection.type === 'day',
      JSON.stringify(st.selection));
    check('redesenhou os cards depois do clique',
      porId.get('meter-grid').children.length > 0);
  }

  /*
   * A queixa que originou estes testes: o card do medidor so virava linha
   * quando um DIA estava escolhido. Semana e "Mes todo" caiam na barra, e como
   * o painel abria no mes todo, a linha praticamente nunca aparecia.
   *
   * O medidor e o PRIMEIRO grafico desenhado em cada rodada de renderAll, entao
   * graficos[0] e sempre o card do primeiro medidor.
   */
  console.log('\ntipo de grafico do medidor (a queixa)');

  const tipoDoMedidor = () => {
    const g = graficos[0];
    const d = g && g.data.datasets[0];
    return g && { tipo: g.type, degrau: d.stepped, curva: d.tension };
  };

  for (const [rotulo, escolher] of [
    ['dia', () => porId.get('day-grid').children.find((c) => c.onclick).onclick()],
    ['semana', () => porId.get('span-grid').children[0].onclick()],
    ['mes todo', () => porId.get('span-grid').children[
      porId.get('span-grid').children.length - 1].onclick()]
  ]) {
    graficos.length = 0;
    escolher();
    const t = tipoDoMedidor();
    // Linha suave, no formato antigo: nem barra, nem escadinha.
    check(`${rotulo}: medidor e linha suave`,
      t && t.tipo === 'line' && !t.degrau && t.curva > 0,
      t ? `type=${t.tipo} stepped=${t.degrau} tension=${t.curva}`
        : 'nenhum grafico desenhado');
  }

  console.log(`\n${passed} passaram, ${failures.length} falharam`);
  if (failures.length) process.exit(1);
}, 300);
