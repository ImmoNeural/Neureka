#!/usr/bin/env python3
"""
varredura_diaria.py
------------------------------------------------------------
Passa o dia a limpo as 11:59 e deixa registrado o que foi descartado.

O QUE ESTA ROTINA NAO E: uma segunda deteccao de picos. O guarda ja roda de
hora em hora dentro do sync_to_site.py, e duas regras diferentes acabariam
discordando entre si - exatamente o que este projeto evita mantendo os guardas
num lugar so. Aqui se usa a MESMA funcao, clean_readings.

O QUE ELA ACRESCENTA, e que a rodada horaria nao dava:

  1. O registro. Ate agora um pico sumia em silencio e sobrava so uma contagem
     no sync_log. Agora fica gravado dia, hora, valor lido e por que caiu, em
     medicao/data/descartes.json, que o site publica.

  2. A revisao com o dia fechado. O guarda horario olha tres leituras adiante;
     no fim do dia ha o dia inteiro. As subidas que sobreviveram e ainda parecem
     grandes saem listadas como "para conferir" - nao sao removidas, porque um
     banho tambem produz subida grande e nao cabe a uma rotina automatica
     decidir isso sem prova. Quem olha decide.

O arquivo e reescrito por inteiro a cada execucao, nao acrescentado. Como o
clean_readings reprocessa todo o historico, reescrever mantem o registro
sempre coerente com a regra vigente; acrescentar deixaria residuo de regras
antigas ali dentro para sempre.

Rodar:  py -3.13 varredura_diaria.py
------------------------------------------------------------
"""

from __future__ import annotations

import sys
import traceback
from datetime import datetime

import pandas as pd

import sync_to_site as sync

# Subida que sobreviveu ao guarda e ainda merece um olho humano.
#
# Bem acima de SALTO_SUSPEITO_LITROS de proposito: aos 20 L qualquer banho
# entraria na lista e ela viraria ruido que ninguem le. Aos 150 L o que aparece
# ou e uso muito fora do comum, ou e leitura errada que escapou - os dois casos
# merecem ser vistos.
SUBIDA_PARA_CONFERIR_LITROS = 150.0


def revisar(room_key: str, origem, logger) -> dict:
    """Roda o filtro de sempre e devolve o que ele descartou, mais o que sobrou
    parecendo grande demais."""
    frame = sync.read_excel_with_retry(origem, logger, room_key)
    resultado = sync.clean_readings(frame)

    conferir = []
    leituras = resultado.readings
    for anterior, atual in zip(leituras, leituras[1:]):
        litros = atual.reading_liters - anterior.reading_liters
        if litros >= SUBIDA_PARA_CONFERIR_LITROS:
            minutos = (atual.timestamp - anterior.timestamp).total_seconds() / 60.0
            conferir.append({
                "timestamp": atual.timestamp.strftime(sync.TIMESTAMP_FORMAT),
                "leitura": atual.reading_m3,
                "litros": litros,
                "minutos": round(minutos, 1),
                "detalhe": (
                    f"subiu {litros} L em {minutos:.0f} min e passou pelos guardas - "
                    "pode ser uso real"
                ),
            })

    return {
        "room_key": room_key,
        "aceitas": len(leituras),
        "descartes": resultado.descartes,
        "conferir": conferir,
    }


def main() -> int:
    inicio = datetime.now().astimezone()
    logger = sync.RunLogger(sync.LOG_PATH, inicio)
    logger.log("varredura=start")

    medidores = []
    for room_key, origem in sync.ROOM_SOURCES.items():
        if not origem.exists():
            continue
        try:
            medidores.append(revisar(room_key, origem, logger))
        except Exception as erro:  # noqa: BLE001 -- uma planilha travada nao derruba o resto
            logger.log(f"varredura room={room_key} erro={type(erro).__name__}: {erro}")

    if not medidores:
        logger.log("varredura=ABORTADA nenhum medidor pode ser lido")
        return 1

    total_descartes = sum(len(m["descartes"]) for m in medidores)
    total_conferir = sum(len(m["conferir"]) for m in medidores)

    sync.write_json(sync.DATA_ROOT / "descartes.json", {
        "gerado_em": inicio.isoformat(),
        "criterio": {
            "salto_suspeito_litros": sync.SALTO_SUSPEITO_LITROS,
            "confirmar_salto_em": sync.CONFIRMAR_SALTO_EM,
            "subida_para_conferir_litros": SUBIDA_PARA_CONFERIR_LITROS,
        },
        "total_descartes": total_descartes,
        "total_conferir": total_conferir,
        "medidores": medidores,
    })

    for m in medidores:
        logger.log(
            f"varredura room={m['room_key']} aceitas={m['aceitas']} "
            f"descartes={len(m['descartes'])} conferir={len(m['conferir'])}"
        )

    # Republica: o registro so serve se chegar ao site junto com os dados.
    resultados = [
        sync.process_room(room_key, origem, logger)
        for room_key, origem in sync.ROOM_SOURCES.items()
    ]
    sync.write_json(
        sync.DATA_ROOT / "manifest.json",
        sync.build_manifest(resultados, inicio.isoformat()),
    )

    saida = sync.commit_and_push(logger, inicio)
    duracao = (datetime.now().astimezone() - inicio).total_seconds()
    logger.log(
        f"varredura=end descartes={total_descartes} conferir={total_conferir} "
        f"exit={saida} duration={duracao:.1f}s"
    )
    return saida


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 -- a tarefa agendada nunca deve ver um traceback cru
        carimbo = datetime.now().strftime(sync.TIMESTAMP_FORMAT)
        print(f"[{carimbo}] varredura=CRASHED\n{traceback.format_exc()}", flush=True)
        sys.exit(2)
