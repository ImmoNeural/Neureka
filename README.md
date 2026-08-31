# Neureka — Monitor de Água

Painel estático que mostra o consumo de água por cômodo. As leituras vêm de câmeras
apontadas para os hidrômetros, lidas por OCR pelo pipeline existente em
`Ch.Hiller/Camera/Leitura.py`. Este repositório **não captura nada** — ele lê as
planilhas que aquele pipeline produz, limpa o ruído do OCR, detecta sessões de uso e
gera JSON estático para o frontend.

O site é HTML + CSS + JavaScript puro. Sem build, sem framework, sem backend.

---

## Layout das pastas

```
Neureka-site/
├── index.html          Estrutura da página (masthead, Medidores, Análises, rodapé)
├── style.css           Todo o estilo. Quente = âmbar, frio = ciano, sempre.
├── app.js              Lê o JSON de data/ e monta os cards e gráficos
├── sync_to_site.py     Excel do OCR → JSON limpo em data/ → commit git
├── tests/
│   └── test_sync.py    48 testes (unittest + pandas, nada toca o pipeline real)
├── data/               ── GERADO. Não editar à mão. ──
│   ├── manifest.json           lista de medidores + estado de cada um
│   └── <room_key>/
│       ├── latest.json         última leitura válida
│       ├── YYYY-MM.json        shard mensal do histórico
│       └── daily.json          agregado por dia (sessões, litros, médias)
└── sync_log.txt        Log operacional. Fora do git (.gitignore).
```

### Contrato de dados

`manifest.json` é a fonte autoritativa. O frontend **nunca** adivinha caminhos: ele só
busca os meses listados em `available_months`, então um mês inexistente jamais vira um
404 no console.

```jsonc
// data/manifest.json
{
  "generated_at": "2026-08-31T15:18:33+02:00",
  "rooms": [
    {
      "room_key": "banheiro_quente",
      "label": "Banheiro - Quente",
      "temperature": "quente",          // derivado do sufixo _quente / _fria
      "has_data": true,                 // false → o card vira placeholder
      "last_reading": 134.522,          // m³
      "last_reading_at": "2026-08-31 15:05:48",
      "last_sync": "2026-08-31T15:18:33+02:00",
      "available_months": ["2026-08"]
    }
  ]
}
```

```jsonc
// data/<room_key>/YYYY-MM.json
[ { "timestamp": "2026-08-31 15:05:48", "reading": 134.522 } ]

// data/<room_key>/daily.json
[ {
  "date": "2026-08-30",
  "session_count": 1, "banho_count": 1, "descarga_count": 0,
  "total_liters": 22,
  "avg_liters_per_banho": 22.0, "avg_liters_per_descarga": 0.0
} ]
```

As médias no painel são **ponderadas**: `daily.json` guarda média e contagem por dia,
então `Σ(média × contagem) / Σ(contagem)` recupera a média real dos últimos 7 dias com
dados. Somar as médias diárias direto daria um número errado em dias com contagens
diferentes.

---

## Rodando localmente

O `fetch()` do navegador bloqueia `file://`. É preciso servir por HTTP:

```bash
cd Neureka-site
py -3.13 -m http.server 8777
# abrir http://127.0.0.1:8777
```

Abrir o `index.html` com duplo clique mostra um alerta vermelho explicando exatamente
isso — é comportamento esperado, não bug.

Gerar/atualizar os dados e rodar os testes:

```bash
py -3.13 sync_to_site.py                      # lê o Excel, escreve data/, commita
py -3.13 -m unittest discover -s tests -v     # 48 testes
```

---

## Adicionando uma câmera nova

**Não precisa mexer em código.** O script já conhece os cinco medidores previstos e
simplesmente pula os que ainda não têm pasta:

| `room_key`        | Caminho do Excel esperado                                     |
|-------------------|---------------------------------------------------------------|
| `banheiro_quente` | `<CAMERA_ROOT>/leituras_hidrometro.xlsx` *(caminho legado)*    |
| `banheiro_fria`   | `<CAMERA_ROOT>/banheiro_fria/leituras_hidrometro.xlsx`         |
| `cozinha_quente`  | `<CAMERA_ROOT>/cozinha_quente/leituras_hidrometro.xlsx`        |
| `cozinha_fria`    | `<CAMERA_ROOT>/cozinha_fria/leituras_hidrometro.xlsx`          |
| `lavanderia_fria` | `<CAMERA_ROOT>/lavanderia_fria/leituras_hidrometro.xlsx`       |

`CAMERA_ROOT` = `C:\Users\Thiago\Documents\Claude Local\Ch.Hiller\Camera`.

Basta apontar o `Leitura.py` da câmera nova para gravar em
`<CAMERA_ROOT>/<room_key>/leituras_hidrometro.xlsx`. Na próxima execução o card
"sem dados ainda" é substituído pelo card real, automaticamente.

A lavanderia é **fria por projeto** — não existe `lavanderia_quente` de propósito.

### Para um cômodo que não está na tabela

Aí sim são duas linhas no `sync_to_site.py`: uma entrada em `ROOM_SOURCES` e outra em
`ROOM_LABELS`. Mantenha o sufixo `_quente` / `_fria` — a temperatura, a cor do card e a
classificação das sessões saem todas dele. O frontend agrupa por cômodo físico cortando
o sufixo (`banheiro_quente` → `banheiro`), então os dois medidores de um banheiro caem
no mesmo card de Análises sozinhos.

---

## Limpeza das leituras (OCR é ruidoso)

Duas travas, aplicadas em sequência sobre a última leitura boa:

1. **Vazão máxima — 25 L/min.** É a trava que realmente pega erro de dígito do OCR. Nos
   dados reais do banheiro, a única linha ruim (`134.463 → 134.641`, +178 L em 3,3 min)
   implica 54 L/min, enquanto todo consumo genuíno fica ≤ 17 L/min. Um chuveiro
   doméstico faz 8–12 L/min e uma torneira 6–10 L/min.
2. **Salto absoluto — 5,0 m³.** Rede de segurança para apagões longos de captura, onde a
   trava de vazão fica permissiva (14 h de intervalo liberariam milhares de litros).

A ordem importa. Só com o limite de 5 m³ nada era rejeitado nos dados reais: o pico
passava, e como uma rejeição nunca rebaixa a "última leitura boa", toda leitura
verdadeira posterior era descartada por parecer retroativa. **Esse único pico custava 13
de 18 linhas** e reportava 134.641 como leitura atual em vez de 134.520.

---

## Heurística de detecção de sessões

Uma sessão é um trecho de leituras **consecutivas e crescentes**:

- Ela **continua** enquanto o medidor sobe e o intervalo entre amostras é ≤ **15 min**
  (`SESSION_MERGE_GAP_MINUTES`).
- Ela **fecha** quando o delta é zero ou negativo (o fluxo parou), ou em qualquer
  intervalo maior.
- Um intervalo > **60 min** (`SESSION_MAX_GAP_MINUTES`) é contado como **apagão de
  captura** e registrado no log — assim um banho tomado com o PC dormindo nunca vira uma
  única sessão gigante.

Classificação, decidida só pelo sufixo do `room_key` e pelo volume, com corte em
**15 L** (`FLUSH_VOLUME_LITERS`):

| Medidor   | Volume  | Rótulo      |
|-----------|---------|-------------|
| `_quente` | ≥ 15 L  | `banho`     |
| `_fria`   | < 15 L  | `descarga`  |
| qualquer outro caso | | `uso`     |

Cozinha e lavanderia passam pela mesma lógica, mas o painel não destaca banho/descarga
para elas — os rótulos só são semanticamente significativos no banheiro.

### ⚠️ Limitação conhecida: cadência de captura

**Esta é a limitação real do sistema, e ela não tem conserto no software.**

A câmera captura a cada ~5–10 min. A janela de fusão de 15 min *precisa* ser maior que
essa cadência, senão cada leitura isolada virava a própria sessão. A consequência direta:

- **Dois usos separados por menos de 15 min viram uma sessão só.** Uma descarga seguida
  de um banho 6 min depois é reportada como um único evento, com o volume somado — e o
  volume somado pode cruzar o corte de 15 L e classificar errado.
- **Um uso mais curto que o intervalo de captura pode sumir por completo**, se começar e
  terminar entre duas fotos e o medidor mal se mover entre elas.
- **Os limites de uma sessão têm a granularidade da cadência**, não do uso real. Um banho
  de 9 min amostrado a cada 7 min tem volume medido com essa precisão, não melhor.

Ou seja: as contagens diárias são um **indicador de tendência confiável**, não uma
contagem exata de eventos. Só aumentar a frequência de captura melhora isso; nenhum
ajuste de constante resolve.

---

## Scheduled Task + script de sync

O `sync_to_site.py` foi escrito para rodar **sem supervisão**, disparado por uma Tarefa
Agendada do Windows (de hora em hora):

```
py -3.13 sync_to_site.py
```

Garantias que ele oferece à Tarefa Agendada:

- **Nunca faz pergunta interativa** e nunca deixa exceção escapar.
- **Uma sala quebrada degrada só ela.** Excel corrompido ou ilegível em um cômodo não
  impede os outros de sincronizar.
- **Tolera o Excel aberto.** O arquivo pode estar sendo escrito pelo OCR ou aberto na
  sua frente; a leitura tem retry.
- **Não gera commit vazio.** Se só o carimbo de tempo do `manifest.json` mudou, o script
  desfaz a alteração e não commita — senão toda execução horária produziria um diff.

Códigos de saída (é o que a Tarefa Agendada enxerga):

| Código | Significado                                                      |
|--------|------------------------------------------------------------------|
| `0`    | Sucesso — inclui "nada mudou" e "ainda sem remote configurado"    |
| `1`    | `git commit` ou `git push` falhou; a próxima execução tenta de novo |
| `2`    | Falha interna inesperada, com traceback no `sync_log.txt`         |

O log de cada execução vai para `sync_log.txt`, que está no `.gitignore` de propósito:
commitá-lo faria toda execução gerar diff, anulando exatamente a lógica de pular commit
vazio.

### Sobre o `git push`

O script já sabe commitar e dar push, **mas o remote ainda não está configurado** — e
isso é tratado como sucesso, não erro. Os commits ficam locais até alguém rodar:

```bash
git remote add origin <url>
git push -u origin main
```

A partir daí a Tarefa Agendada passa a publicar sozinha a cada execução com dados novos.

---

## Frontend

- **Chart.js 4.4.1** via CDN, com `integrity` (SRI) e `crossorigin`. Se o CDN cair, o
  painel detecta, mostra um aviso e continua exibindo todos os números — só os gráficos
  somem. Nada de tela em branco.
- **Sem `innerHTML` para dado externo.** Todo texto vindo do JSON entra por
  `textContent`; um rótulo malicioso não vira markup.
- Cada shard é buscado em paralelo, e um shard que falha não zera o painel.
- O masthead é `position: sticky` e fica fixo no topo durante a rolagem.
- Responsivo em coluna única a partir de 720 px, com ajustes extras abaixo de 400 px.
- Estados do indicador de sincronização: **verde** (recente), **âmbar** (> 3 h sem
  sync — três execuções horárias perdidas), **vermelho** (manifest não carregou).
