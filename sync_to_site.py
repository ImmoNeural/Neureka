#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_to_site.py -- Neureka water-monitoring site sync.

Reads the camera+OCR Excel logs produced by Ch.Hiller/Camera/Leitura.py, cleans the
noisy OCR readings, detects water-usage sessions, and emits static JSON under
./data/ for the frontend. Then commits (and pushes, if a remote is configured).

Designed to run unattended from a Windows Scheduled Task:

    py -3.13 sync_to_site.py

No interactive prompts. Never raises an unhandled exception. A single unreadable
or corrupt room file degrades that room only -- every other room still syncs.

Exit codes:
    0  success (including "nothing changed" and "no git remote configured yet")
    1  git commit or git push failed -- the next scheduled run will retry
    2  unexpected internal failure (logged with traceback)
"""

from __future__ import annotations

import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SITE_ROOT = Path(__file__).resolve().parent

# The meter dashboard lives under /medicao, not at the domain root.
#
# The webroot on the host IS this repository, so a file's path here is its URL
# there. Keeping the dashboard in its own folder means neureka-ai.com/ is free
# for the landing page, and -- the reason it was done -- Cloudflare Access can
# be pointed at exactly one path instead of the whole domain.
PUBLIC_ROOT = SITE_ROOT / "medicao"
DATA_ROOT = PUBLIC_ROOT / "data"
LOG_PATH = SITE_ROOT / "sync_log.txt"

# Root of the existing (live, do-not-touch) camera pipeline.
CAMERA_ROOT = Path(r"C:\Users\Thiago\Documents\Claude Local\Ch.Hiller\Camera")

EXCEL_FILENAME = "leituras_hidrometro.xlsx"

# Repo-relative path to the manifest, and the manifest keys that change on every run
# regardless of whether any water data changed.
MANIFEST_REL_PATH = "data/manifest.json"
VOLATILE_MANIFEST_KEYS = ('"last_sync"', '"generated_at"')

# Every meter this site knows about, in display order.
# banheiro_quente is the meter that exists today and lives at the pipeline's
# original flat path. The other four are looked up at
# <CAMERA_ROOT>/<room_key>/leituras_hidrometro.xlsx and are simply skipped until
# that folder appears -- installing a new camera needs zero code changes here.
# Laundry is cold-only by design; there is deliberately no lavanderia_quente.
ROOM_SOURCES: dict[str, Path] = {
    "banheiro_quente": CAMERA_ROOT / EXCEL_FILENAME,
    "banheiro_fria": CAMERA_ROOT / "banheiro_fria" / EXCEL_FILENAME,
    "cozinha_quente": CAMERA_ROOT / "cozinha_quente" / EXCEL_FILENAME,
    "cozinha_fria": CAMERA_ROOT / "cozinha_fria" / EXCEL_FILENAME,
    "lavanderia_fria": CAMERA_ROOT / "lavanderia_fria" / EXCEL_FILENAME,
}

# Human-readable labels for the frontend, so room naming lives in exactly one place.
ROOM_LABELS: dict[str, str] = {
    "banheiro_quente": "Banheiro - Quente",
    "banheiro_fria": "Banheiro - Fria",
    "cozinha_quente": "Cozinha - Quente",
    "cozinha_fria": "Cozinha - Fria",
    "lavanderia_fria": "Lavanderia - Fria",
}

# ---------------------------------------------------------------------------
# Tuning constants
# ---------------------------------------------------------------------------

# Absolute ceiling on how far a reading may exceed the last known-good one, in cubic
# metres. This is the backstop that bounds consumption across a long capture outage,
# where the rate guard below becomes permissive (a 14-hour gap would otherwise allow
# a jump of thousands of litres).
MAX_PLAUSIBLE_JUMP_M3 = 5.0

# Ceiling on implied flow rate between two consecutive readings, in litres/minute.
#
# This is the guard that actually catches OCR digit misreads. On the real bathroom
# data the single bad row (134.463 -> 134.641, +178 L in 3.3 min) implies 54 L/min,
# while every genuine draw stays at or below 17 L/min -- a domestic shower runs
# 8-12 L/min and a tap 6-10 L/min. 25 L/min sits clearly above real usage and well
# below misread territory.
#
# MAX_PLAUSIBLE_JUMP_M3 alone cannot do this job: at 5.0 m3 it rejects nothing on
# real data, so the spike is accepted, and because a rejection never lowers "last
# known good", every later true reading is then discarded as backwards. That single
# spike cost 13 of 18 rows and reported 134.641 as current instead of 134.520.
# Lowered from 25 to 20 on 2026-09-14. The paragraph above still holds - every
# genuine draw in the series stays at or below 17 L/min - but 25 turned out to
# sit INSIDE misread territory, not below it: a 240-litre misread on 2026-09-14
# implied 24 L/min and cleared the ceiling by a hair. 20 keeps the margin over
# real usage and closes that gap. Must stay equal to Leitura.py's
# MAX_VAZAO_M3_POR_HORA (1.2 m3/h): two numbers for the same physics would be
# two judges disagreeing.
MAX_FLOW_RATE_LITERS_PER_MIN = 20.0

# How many accepted readings form the anchor the backwards guard compares against.
#
# Do NOT compare against the single last accepted reading. That is not a style
# preference -- it is the failure mode that took this site off the air for five
# hours on 2026-09-12, and the paragraph above describes its cousin.
#
# What happened: at 17:53:31 the OCR read 134.966 where the truth was 134.965 --
# ONE litre too high, well inside the noise of the thousandths wheel. That litre
# became the floor. The next nine readings were all correct and all sat one litre
# below it, so every one was rejected as "backwards". Because a rejection never
# lowers the floor, the gate stayed shut: the site would have kept reporting
# 134.966 until the household drew one more litre of hot water than it already had.
#
# The upstream reader (Leitura.py) assumes 5 for the thousandths digit when the
# wheel is in motion, with a declared error of +-5 litres. So a one-litre
# disagreement between consecutive readings is EXPECTED, not evidence of a misread.
#
# A median over five accepted readings cannot be moved by a single high outlier,
# so the floor repairs itself on the next good reading instead of latching shut.
ANCHOR_WINDOW = 5

# Tolerance below the anchor, in cubic metres, before a reading counts as going
# backwards. 0.005 m3 = 5 litres = exactly the uncertainty Leitura.py injects when
# it assumes the spinning thousandths digit. It is not licence to run backwards:
# the real misreads this guard must catch are 20-320 litres, far outside it.
BACKWARDS_TOLERANCE_M3 = 0.005

# How many consecutive backwards-rejected readings it takes to overrule the anchor.
#
# The median anchor above fixes one bad reading among good ones. It cannot fix a bad
# reading that blocks every successor, because the window only refreshes when
# something is ACCEPTED -- and nothing is. On 2026-09-13 the cold meter published a
# single misread of 186.465 and then rejected 29 consecutive readings of 186.195,
# every one of them correct, for nine hours. One reading outvoted twenty-nine.
#
# So the anchor is not the last word. When this many readings in a row are rejected
# as backwards AND they agree with each other, they win: independent measurements
# converging on the same value are evidence, and a lone value contradicting all of
# them is a misread. The accepted readings sitting above that consensus are dropped,
# the run is admitted, and the series continues from the truth.
# Three, not two -- measured, not argued.
#
# Lowering it to 2 on 2026-09-14 looked free: a wrong HIGH reading enters by the
# 'rising is allowed' path, so only the correct lower readings ever wait on
# consensus, and waiting less means less time serving a wrong number.
#
# The measurement on the real series killed it. Hot water: backwards rejections
# 88 -> 198, published readings 240 -> 126. Because every consensus discards the
# accepted readings sitting above the agreed level, a low gate on a noisy OCR
# fires constantly and each firing takes a slice of the series with it. Backward
# steps did improve, 25 -> 15 -- real, but not worth half the data.
REANCHOR_AFTER = 3

# How tightly the rejected run must agree with itself to count as consensus, in m3.
# Wide enough to allow real consumption during the run, tight enough that scattered
# OCR noise never looks like agreement. Three random misreads landing within 50
# litres of each other is not something the failure mode produces.
REANCHOR_SPREAD_M3 = 0.05

# ---------------------------------------------------------------------------
# Quarantine for a big jump: confirm it before publishing it
# ---------------------------------------------------------------------------

# A rise above this is not published on the spot -- it waits for the readings that
# come after it to agree.
#
# Why an ABSOLUTE ceiling was missing. MAX_FLOW_RATE_LITERS_PER_MIN asks "could
# this much water fit in the elapsed time", so a big misread spread over a long
# interval slips underneath it: on 2026-09-15 the hot meter jumped 430 L over 72
# minutes, which is 5.97 L/min, comfortably below the 20 L/min ceiling. It was
# accepted, and the next reading came back 402 L lower.
#
# 20 L is deliberately low -- a real shower clears it easily. That is fine,
# because crossing this line DELAYS a reading, it never rejects one. A genuine
# draw is published one run later, with its timestamp intact.
SALTO_SUSPEITO_LITROS = 20.0

# How many readings after the jump have to agree before it is published.
#
# The rule is the meter's own physics, not a heuristic: a cumulative meter cannot
# run backwards, so if the readings that follow a jump sit BELOW it, the jump
# never happened and what we saw was a misread. Three readings at the current
# cadence is about an hour -- slower than the hourly publish, which is why a
# still-unconfirmed jump simply waits for the next run instead of being decided
# on thin evidence.
CONFIRMAR_SALTO_EM = 3

# Two consecutive readings closer together in time than this (and still rising) are
# considered the same continuous draw. Must exceed the camera's capture cadence
# (~5-10 min) or every single reading becomes its own session.
SESSION_MERGE_GAP_MINUTES = 15

# A gap larger than this means the capture pipeline was down (PC asleep, camera
# offline). Any consumption spanning such a gap is NOT attributed to one giant
# session -- the run is closed and the outage is logged.
SESSION_MAX_GAP_MINUTES = 60

# A gap longer than this is treated as a PLANNED ABSENCE rather than a capture
# failure: the meters were switched off on purpose (a trip), not lost.
#
# The distinction is not cosmetic. On the first 13 days of real data a single
# 209.5 h gap -- one week away with the boards unplugged -- dragged coverage down
# to 11.4%, which reads as a broken pipeline. The twelve genuine outages in the
# same period total 69.3 h, and coverage outside the absence is 34.0%. One of
# those numbers is a fault to chase; the other is a holiday.
#
# Intent is never inferred from anything but duration. Nothing here knows about
# travel -- it only knows that a gap this long is a different kind of event from
# a board that browned out for two hours, and reports both instead of blending
# them into one misleading percentage.
LONG_ABSENCE_HOURS = 24.0

# Volume threshold separating a toilet flush from a shower, in litres.
FLUSH_VOLUME_LITERS = 15

# ---------------------------------------------------------------------------
# Excel read retry policy (the source file may be open in Excel, or mid-write by
# Leitura.py, at any moment)
# ---------------------------------------------------------------------------

EXCEL_READ_ATTEMPTS = 3
EXCEL_RETRY_BACKOFF_SECONDS = (1.5, 3.0)  # waits after attempt 1 and attempt 2

# Every git subprocess is bounded; an unbounded git call would hang the Scheduled Task.
GIT_TIMEOUT_SECONDS = 120

# Source column names, exactly as Leitura.py writes them.
COL_TIMESTAMP = "Data/Hora da Foto"
COL_READING = "Leitura Completa"
TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

class RunLogger:
    """Append-only run log. Writes to sync_log.txt and mirrors to stdout.

    Log failures never abort the sync -- losing the log is strictly less bad than
    losing the data refresh.
    """

    def __init__(self, path: Path, run_started: datetime) -> None:
        self._path = path
        self._stamp = run_started.strftime(TIMESTAMP_FORMAT)

    def log(self, message: str) -> None:
        line = f"[{self._stamp}] {message}"
        print(line, flush=True)
        try:
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError as exc:
            # stdout still carries the message; the Scheduled Task captures it.
            print(f"[{self._stamp}] WARN could not write log file: {exc}", flush=True)


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Reading:
    """One accepted meter reading."""
    timestamp: datetime
    reading_m3: float
    reading_liters: int  # integer litres -- session maths stays exact, no float drift


@dataclass
class CleanResult:
    readings: list[Reading]
    rows_read: int
    rejected_unparsable: int
    rejected_backwards: int
    rejected_jump: int
    rejected_rate: int
    # Jumps the readings after them contradicted, plus jumps still too recent to
    # have been confirmed. Counted apart because the two mean different things:
    # the first is a misread caught, the second is only a reading waiting its turn.
    rejected_spike: int = 0
    pendente_confirmacao: int = 0
    # Cada leitura descartada por um guarda FISICO, com o porque. Existe para a
    # varredura diaria poder dizer "sumi com este pico, deste dia, deste horario"
    # em vez de so publicar uma contagem. Nao inclui as ilegiveis: aquelas nunca
    # chegaram a ser um numero, entao nao ha o que registrar.
    descartes: list[dict[str, Any]] = field(default_factory=list)

    @property
    def rejected_total(self) -> int:
        return (
            self.rejected_unparsable
            + self.rejected_backwards
            + self.rejected_jump
            + self.rejected_rate
            + self.rejected_spike
        )


@dataclass(frozen=True)
class Session:
    start_time: datetime
    end_time: datetime
    volume_liters: int
    session_type: str  # "banho" | "descarga" | "uso"


@dataclass
class RoomResult:
    room_key: str
    has_data: bool
    clean: CleanResult | None = None
    sessions: list[Session] = field(default_factory=list)
    outages: int = 0
    error: str | None = None


class ExcelUnavailable(Exception):
    """The source workbook could not be read this cycle (locked, missing, corrupt)."""


# ---------------------------------------------------------------------------
# Reading the source workbook
# ---------------------------------------------------------------------------

def read_excel_with_retry(path: Path, logger: RunLogger, room_key: str) -> pd.DataFrame:
    """Read the workbook, tolerating transient Windows file locks.

    Excel holding the file, or Leitura.py rewriting it via to_excel(), surfaces as
    PermissionError / OSError / BadZipFile / ValueError depending on the exact
    instant we hit it. All of them are transient, so all of them are retried.
    """
    last_error: Exception | None = None

    for attempt in range(1, EXCEL_READ_ATTEMPTS + 1):
        try:
            # Copy first: reading the copy means a mid-read rewrite by Leitura.py
            # cannot hand pandas a half-written zip.
            with tempfile.TemporaryDirectory() as tmpdir:
                snapshot = Path(tmpdir) / path.name
                shutil.copy2(path, snapshot)
                return pd.read_excel(snapshot, engine="openpyxl")
        except (PermissionError, OSError, zipfile.BadZipFile, ValueError, KeyError) as exc:
            last_error = exc
            if attempt < EXCEL_READ_ATTEMPTS:
                wait = EXCEL_RETRY_BACKOFF_SECONDS[attempt - 1]
                logger.log(
                    f"room={room_key} read attempt {attempt}/{EXCEL_READ_ATTEMPTS} "
                    f"failed ({type(exc).__name__}: {exc}); retrying in {wait}s"
                )
                time.sleep(wait)

    raise ExcelUnavailable(
        f"{type(last_error).__name__}: {last_error}"
    ) from last_error


# ---------------------------------------------------------------------------
# Cleaning
# ---------------------------------------------------------------------------

def clean_readings(frame: pd.DataFrame) -> CleanResult:
    """Sort by time, coerce types, and reject physically impossible readings.

    A cumulative meter can only ever go up, and it can only go up as fast as water
    can physically flow through it. A reading is rejected when it is:
      * below the ANCHOR by more than BACKWARDS_TOLERANCE_M3 (meters do not run
        backwards), where the anchor is the median of the last ANCHOR_WINDOW
        accepted readings -- not the single last one, which latches the gate shut
        after any one-litre over-read (see ANCHOR_WINDOW for the incident),
      * above the last accepted reading by more than MAX_PLAUSIBLE_JUMP_M3
        (absolute backstop), or
      * above it fast enough to imply more than MAX_FLOW_RATE_LITERS_PER_MIN.

    The jump and rate guards stay anchored to the last accepted reading and its
    timestamp, because both are statements about two samples adjacent in TIME. Only
    the backwards guard uses the median, because it is a statement about where the
    meter actually stands, and that estimate must survive one bad reading.

    Rejection never advances "last known good". A reading accepted slightly below it
    is allowed to lower it -- that is the self-repair, and it is safe: sessions only
    extend while the meter rises and only record volume > 0, so a one-litre
    correction downwards closes the current run instead of inventing consumption.
    """
    rows_read = len(frame)

    missing = [c for c in (COL_TIMESTAMP, COL_READING) if c not in frame.columns]
    if missing:
        raise ExcelUnavailable(f"missing required column(s): {', '.join(missing)}")

    working = frame[[COL_TIMESTAMP, COL_READING]].copy()

    # Leitura.py writes the timestamp as a plain string, but a workbook that has been
    # opened and re-saved in Excel can come back as a real datetime -- accept both.
    timestamps = pd.to_datetime(
        working[COL_TIMESTAMP], format=TIMESTAMP_FORMAT, errors="coerce"
    )
    unformatted = timestamps.isna()
    if unformatted.any():
        timestamps = timestamps.fillna(
            pd.to_datetime(working[COL_TIMESTAMP], errors="coerce")
        )
    working["_ts"] = timestamps
    working["_reading"] = pd.to_numeric(working[COL_READING], errors="coerce")

    parsable = working["_ts"].notna() & working["_reading"].notna()
    rejected_unparsable = int((~parsable).sum())
    working = working[parsable].sort_values("_ts", kind="stable")

    readings: list[Reading] = []
    rejected_backwards = 0
    rejected_jump = 0
    rejected_rate = 0
    rejected_spike = 0
    pendente_confirmacao = 0
    descartes: list[dict[str, Any]] = []

    def anotar(quando: datetime, valor: float, motivo: str, detalhe: str) -> None:
        """Guarda o que foi descartado, para a varredura diaria poder listar."""
        descartes.append({
            "timestamp": quando.strftime(TIMESTAMP_FORMAT),
            "leitura": round(valor, 3),
            "motivo": motivo,
            "detalhe": detalhe,
        })
    last_good_m3: float | None = None
    last_good_ts: datetime | None = None
    # Backwards-rejected readings still waiting to see whether the next ones agree
    # with them. They are neither accepted nor counted as rejected until that is
    # settled -- by corroboration (they win) or by a normal acceptance (they lose).
    pending_backwards: list[tuple[datetime, float]] = []

    # Materialised instead of streamed: confirming a jump means reading the samples
    # that come AFTER it, which a zip() cursor cannot do.
    amostras = list(zip(working["_ts"], working["_reading"]))

    for indice, (timestamp, reading_m3) in enumerate(amostras):
        value = float(reading_m3)
        moment = timestamp.to_pydatetime()

        if last_good_m3 is not None and last_good_ts is not None:
            recent = [r.reading_m3 for r in readings[-ANCHOR_WINDOW:]]
            anchor = statistics.median(recent) if recent else last_good_m3
            if value < anchor - BACKWARDS_TOLERANCE_M3:
                pending_backwards.append((moment, value))
                run = [v for _, v in pending_backwards]
                if (len(run) >= REANCHOR_AFTER
                        and max(run) - min(run) <= REANCHOR_SPREAD_M3):
                    # Consensus beats the anchor. Drop whatever was accepted above
                    # the agreed level -- that is the misread that latched the gate --
                    # then admit the whole run and carry on from it.
                    consensus = statistics.median(run)
                    while readings and readings[-1].reading_m3 > consensus + BACKWARDS_TOLERANCE_M3:
                        readings.pop()
                        rejected_backwards += 1
                    for pending_ts, pending_value in pending_backwards:
                        readings.append(
                            Reading(
                                timestamp=pending_ts,
                                reading_m3=round(pending_value, 3),
                                reading_liters=int(round(pending_value * 1000)),
                            )
                        )
                    last_good_m3 = readings[-1].reading_m3
                    last_good_ts = readings[-1].timestamp
                    pending_backwards = []
                continue
            if value - last_good_m3 > MAX_PLAUSIBLE_JUMP_M3:
                rejected_jump += 1
                anotar(
                    moment, value, "salto absurdo",
                    f"subiu {(value - last_good_m3) * 1000:.0f} L de uma vez, acima "
                    f"do teto de {MAX_PLAUSIBLE_JUMP_M3 * 1000:.0f} L",
                )
                continue

            elapsed_minutes = (moment - last_good_ts).total_seconds() / 60.0
            # Duplicate timestamps carry no elapsed time, so no rate can be derived;
            # the absolute jump check above is the only guard that applies to them.
            if elapsed_minutes > 0:
                litres_gained = (value - last_good_m3) * 1000.0
                if litres_gained / elapsed_minutes > MAX_FLOW_RATE_LITERS_PER_MIN:
                    rejected_rate += 1
                    anotar(
                        moment, value, "vazao impossivel",
                        f"exigiria {litres_gained / elapsed_minutes:.1f} L/min desde "
                        f"{last_good_m3:.3f}, acima do teto de "
                        f"{MAX_FLOW_RATE_LITERS_PER_MIN:.0f} L/min",
                    )
                    continue

            # ---- quarentena do salto grande ----
            #
            # Passou pelos guardas acima e ainda assim subiu muito de uma vez. A
            # pergunta que decide nao esta neste par de leituras, e sim nas que
            # vierem depois: o relogio e acumulado, entao se ele DESCE abaixo deste
            # valor, a agua nunca passou e o que vimos foi erro de leitura.
            #
            # Nao ha voto nem media aqui de proposito. Uma unica leitura posterior
            # mais baixa ja e prova fisica suficiente - foi assim que o pico de
            # 420 L de 17/09 09:58 se denunciou na leitura das 10:20.
            # Arredondado para litro INTEIRO antes de comparar, e nao por
            # capricho de formatacao.
            #
            # 135.585 - 135.565 nao da 0.020 em ponto flutuante: da
            # 0.020000000000010232. Multiplicado por mil vira 20.000000000010232,
            # que e maior que 20 por uma parte em dois trilhoes - e uma subida de
            # exatos 20 L, das mais banais que existem, caia em quarentena por
            # isso. Aconteceu em 21/09/2026 as 11:00 e parou a publicacao da agua
            # quente por horas.
            #
            # O medidor resolve 1 litro (a Modulatorscheibe do domaqua m gira uma
            # volta por litro), entao diferenca abaixo disso nao significa nada e
            # comparar inteiros elimina a fragilidade na raiz.
            litros_do_salto = round((value - last_good_m3) * 1000.0)
            if litros_do_salto > SALTO_SUSPEITO_LITROS:
                seguintes = [
                    float(v)
                    for _, v in amostras[indice + 1: indice + 1 + CONFIRMAR_SALTO_EM]
                ]
                if len(seguintes) < CONFIRMAR_SALTO_EM:
                    # Recente demais para julgar. Fica de fora desta publicacao e e
                    # reavaliado na proxima rodada, quando as leituras existirem -
                    # o clean roda sobre o historico inteiro toda vez.
                    pendente_confirmacao += 1
                    continue
                contradiz = [s for s in seguintes if s < value - BACKWARDS_TOLERANCE_M3]
                if contradiz:
                    rejected_spike += 1
                    anotar(
                        moment, value, "pico contradito",
                        f"subiu {(value - last_good_m3) * 1000:.0f} L sobre "
                        f"{last_good_m3:.3f}, mas as leituras seguintes voltaram "
                        f"para {min(contradiz):.3f} - o relogio nao anda para tras",
                    )
                    continue

        # A normal acceptance settles the question: the readings held back before it
        # never found corroboration, so they were genuine rejections after all.
        rejected_backwards += len(pending_backwards)
        pending_backwards = []

        last_good_m3 = value
        last_good_ts = moment
        readings.append(
            Reading(
                timestamp=moment,
                reading_m3=round(value, 3),
                reading_liters=int(round(value * 1000)),
            )
        )

    # Whatever is still pending at the end never found corroboration.
    rejected_backwards += len(pending_backwards)

    return CleanResult(
        readings=readings,
        rows_read=rows_read,
        rejected_unparsable=rejected_unparsable,
        rejected_backwards=rejected_backwards,
        rejected_jump=rejected_jump,
        rejected_rate=rejected_rate,
        rejected_spike=rejected_spike,
        pendente_confirmacao=pendente_confirmacao,
        descartes=descartes,
    )


# ---------------------------------------------------------------------------
# Session detection
# ---------------------------------------------------------------------------

def classify_session(room_key: str, volume_liters: int) -> str:
    """Label a session from the meter's hot/cold suffix and its volume.

    Only the _quente / _fria suffix is inspected -- never the room name itself -- so
    new rooms classify automatically. The labels are semantically meaningful for the
    bathroom; kitchen and laundry sessions get the same treatment and are simply not
    highlighted as banho/descarga in the UI.
    """
    if room_key.endswith("_fria") and volume_liters < FLUSH_VOLUME_LITERS:
        return "descarga"
    if room_key.endswith("_quente") and volume_liters >= FLUSH_VOLUME_LITERS:
        return "banho"
    return "uso"


def detect_sessions(room_key: str, readings: list[Reading]) -> tuple[list[Session], int]:
    """Group rising consecutive readings into usage sessions.

    A session extends while the meter rises AND the two samples are no more than
    SESSION_MERGE_GAP_MINUTES apart. It closes on a flat/negative delta (flow
    stopped) or on any larger gap. A gap beyond SESSION_MAX_GAP_MINUTES is
    additionally counted as a capture outage, so a shower that happened while the
    pipeline was down is never reported as one enormous session.

    Returns (sessions, outage_count).
    """
    sessions: list[Session] = []
    outages = 0

    start_index: int | None = None
    end_index: int | None = None

    def close() -> None:
        nonlocal start_index, end_index
        if start_index is not None and end_index is not None:
            start = readings[start_index]
            end = readings[end_index]
            volume = end.reading_liters - start.reading_liters
            if volume > 0:
                sessions.append(
                    Session(
                        start_time=start.timestamp,
                        end_time=end.timestamp,
                        volume_liters=volume,
                        session_type=classify_session(room_key, volume),
                    )
                )
        start_index = None
        end_index = None

    for index in range(1, len(readings)):
        previous = readings[index - 1]
        current = readings[index]
        gap_minutes = (current.timestamp - previous.timestamp).total_seconds() / 60.0
        rising = current.reading_liters > previous.reading_liters

        if gap_minutes > SESSION_MAX_GAP_MINUTES:
            outages += 1
            close()
            continue

        if rising and gap_minutes <= SESSION_MERGE_GAP_MINUTES:
            if start_index is None:
                start_index = index - 1
            end_index = index
            continue

        # Flat/negative delta, or a gap between MERGE and MAX: the run ends here.
        close()

    close()
    return sessions, outages


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def build_daily_summary(sessions: Iterable[Session]) -> list[dict[str, Any]]:
    """Per-calendar-day rollup, recomputed from the full session history each run.

    Sessions are attributed to the day they STARTED on. Averages are 0.0 when the
    corresponding count is zero, so the frontend never has to handle nulls.
    """
    buckets: dict[str, dict[str, Any]] = {}

    for session in sessions:
        day = session.start_time.strftime("%Y-%m-%d")
        bucket = buckets.setdefault(
            day,
            {
                "date": day,
                "session_count": 0,
                "banho_count": 0,
                "descarga_count": 0,
                "total_liters": 0,
                "_banho_liters": 0,
                "_descarga_liters": 0,
            },
        )
        bucket["session_count"] += 1
        bucket["total_liters"] += session.volume_liters
        if session.session_type == "banho":
            bucket["banho_count"] += 1
            bucket["_banho_liters"] += session.volume_liters
        elif session.session_type == "descarga":
            bucket["descarga_count"] += 1
            bucket["_descarga_liters"] += session.volume_liters

    daily: list[dict[str, Any]] = []
    for day in sorted(buckets):
        bucket = buckets[day]
        banho_count = bucket["banho_count"]
        descarga_count = bucket["descarga_count"]
        daily.append(
            {
                "date": bucket["date"],
                "session_count": bucket["session_count"],
                "banho_count": banho_count,
                "descarga_count": descarga_count,
                "total_liters": bucket["total_liters"],
                "avg_liters_per_banho": (
                    round(bucket["_banho_liters"] / banho_count, 1) if banho_count else 0.0
                ),
                "avg_liters_per_descarga": (
                    round(bucket["_descarga_liters"] / descarga_count, 1)
                    if descarga_count
                    else 0.0
                ),
            }
        )
    return daily


# ---------------------------------------------------------------------------
# JSON output
# ---------------------------------------------------------------------------

def write_json(path: Path, payload: Any) -> None:
    """Atomic JSON write -- a crashed or killed run never leaves a truncated file
    that the frontend would fail to parse."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp"
    )
    try:
        with handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=False)
            handle.write("\n")
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise


def read_existing_shard(path: Path, logger: RunLogger) -> list[dict[str, Any]]:
    """Load a previously written monthly shard, tolerating a corrupt/legacy file.

    A shard we cannot parse is treated as empty: this run then rewrites it from the
    Excel history, which is the authoritative source anyway.
    """
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.log(f"WARN unreadable shard {path.name} ({exc}); rebuilding it")
        return []

    if not isinstance(payload, list):
        logger.log(f"WARN shard {path.name} is not a JSON array; rebuilding it")
        return []
    return [item for item in payload if isinstance(item, dict) and "timestamp" in item]


def write_monthly_shards(
    room_dir: Path, readings: list[Reading], logger: RunLogger
) -> list[str]:
    """Write per-month shards from the cleaned series, keyed on timestamp.

    Any month present in the current Excel history is rewritten from that history,
    which is the authoritative source. That keeps the operation idempotent (re-running
    never duplicates a point) while still letting a change to the cleaning rules
    propagate into already-written shards -- a pure union-merge would pin every
    previously-accepted OCR spike into the archive permanently.

    Months with no rows in the current Excel are left untouched, so shards remain a
    full-history archive even if the source workbook is ever trimmed or rotated.

    Returns the sorted month keys covered by this run.
    """
    by_month: dict[str, dict[str, dict[str, Any]]] = {}
    for reading in readings:
        key = reading.timestamp.strftime(TIMESTAMP_FORMAT)
        month = reading.timestamp.strftime("%Y-%m")
        by_month.setdefault(month, {})[key] = {
            "timestamp": key,
            "reading": reading.reading_m3,
        }

    for month, points in by_month.items():
        shard_path = room_dir / f"{month}.json"
        previous = len(read_existing_shard(shard_path, logger))
        if previous and previous != len(points):
            logger.log(
                f"shard {month}.json rewritten from source: {previous} -> {len(points)} points"
            )
        write_json(shard_path, [points[key] for key in sorted(points)])

    return sorted(by_month)


# ---------------------------------------------------------------------------
# Volume analysis
# ---------------------------------------------------------------------------
#
# Why this exists alongside the session analysis, and why it is the honest one.
#
# A cumulative meter measures VOLUME exactly, even when sampled coarsely. What a
# coarse sample destroys is WHEN and HOW FAST -- not HOW MUCH. The session layer
# answers "how many showers", and at a ~10 minute sampling interval it answers it
# badly: on 13 days of real bathroom data it attributed 124 of 512 litres, so 76%
# of the water that actually flowed was invisible to it, and the three showers it
# did find implied 1.5-4.7 L/min where a real shower runs 8-12.
#
# So this layer reports only what the meter genuinely knows: litres per day, litres
# per hour of day, and how much of the period was observed at all. Consumption that
# falls inside a capture gap is counted in the total but reported separately, so a
# blind spot can never masquerade as a quiet day.

def slice_by_hour(start: datetime, end: datetime) -> Iterator[tuple[datetime, float]]:
    """Break [start, end) into pieces that never cross an hour boundary.

    Yields (piece_start, minutes). An interval spanning midnight or an hour mark is
    split, so its consumption lands on every day and hour it actually covers instead
    of piling onto whichever timestamp happened to close it.
    """
    cursor = start
    while cursor < end:
        next_hour = cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        stop = min(next_hour, end)
        yield cursor, (stop - cursor).total_seconds() / 60.0
        cursor = stop


def build_volume_analysis(readings: list[Reading]) -> dict[str, Any]:
    """Measured volume per day and per hour-of-day, plus honest coverage numbers.

    Every consecutive pair of accepted readings contributes its delta, spread over
    the days and hours the interval spans in proportion to time. An interval longer
    than SESSION_MAX_GAP_MINUTES is a capture gap: its volume is real and counted,
    but it is tagged so the UI can show it as unplaced rather than pretending to know
    when it happened.

    The hourly profile also carries observed minutes, because raw hourly totals are
    biased towards whichever hours the camera happened to be alive for. Litres per
    observed hour is the comparable number, and it is left null below half an hour of
    observation, where the ratio would be noise amplified by a small denominator.
    """
    if len(readings) < 2:
        return {}

    daily: dict[str, dict[str, float]] = {}
    hourly: dict[int, dict[str, float]] = {
        hour: {"liters": 0.0, "observed_minutes": 0.0} for hour in range(24)
    }
    # Litros por hora de CADA dia, nao por hora-do-dia agregada.
    #
    # O "hourly" acima responde "a que horas esta casa costuma gastar agua".
    # Este responde "o que aconteceu no dia 16", que e outra pergunta e a que o
    # grafico do dia faz. Preenchido no mesmo laco e sob a mesma condicao: so
    # entra o que foi observado de fato, entao a agua de uma lacuna continua
    # fora - ela e real, mas ninguem sabe em que hora passou.
    by_day_hour: dict[str, list[float]] = {}
    observed_minutes = gap_minutes = 0.0
    observed_liters = gap_liters = 0.0
    absence_minutes = outage_minutes = 0.0
    absence_liters = outage_liters = 0.0
    gap_count = 0
    gaps: list[dict[str, Any]] = []

    for index in range(1, len(readings)):
        previous, current = readings[index - 1], readings[index]
        minutes = (current.timestamp - previous.timestamp).total_seconds() / 60.0
        if minutes <= 0:
            continue
        # SIGNED, not clamped at zero. Clamping looks harmless and is not: the
        # backwards guard tolerates 5 litres of thousandths-wheel noise, so a
        # reading may dip a litre and recover. Summing max(0, delta) counts the
        # recovery without ever counting the dip, and the total drifts upwards --
        # it reported 553 L on data whose endpoints differ by 512. Signed deltas
        # telescope: their sum is exactly last minus first, always.
        litres = current.reading_liters - previous.reading_liters
        is_gap = minutes > SESSION_MAX_GAP_MINUTES
        is_absence = minutes > LONG_ABSENCE_HOURS * 60
        if is_gap:
            gap_count += 1
            gap_minutes += minutes
            gap_liters += litres
            gaps.append({
                "from": previous.timestamp.strftime(TIMESTAMP_FORMAT),
                "to": current.timestamp.strftime(TIMESTAMP_FORMAT),
                "hours": round(minutes / 60.0, 1),
                "liters": max(0, litres),
                "kind": "absence" if is_absence else "outage",
            })
            if is_absence:
                absence_minutes += minutes
                absence_liters += litres
            else:
                outage_minutes += minutes
                outage_liters += litres
        else:
            observed_minutes += minutes
            observed_liters += litres

        for piece_start, piece_minutes in slice_by_hour(previous.timestamp, current.timestamp):
            share = piece_minutes / minutes
            day = daily.setdefault(
                piece_start.strftime("%Y-%m-%d"),
                {"liters": 0.0, "gap_liters": 0.0,
                 "observed_minutes": 0.0, "gap_minutes": 0.0},
            )
            day["liters"] += litres * share
            if is_gap:
                day["gap_liters"] += litres * share
                day["gap_minutes"] += piece_minutes
            else:
                day["observed_minutes"] += piece_minutes
                bucket = hourly[piece_start.hour]
                bucket["liters"] += litres * share
                bucket["observed_minutes"] += piece_minutes
                day_key = piece_start.strftime("%Y-%m-%d")
                by_day_hour.setdefault(day_key, [0.0] * 24)
                by_day_hour[day_key][piece_start.hour] += litres * share

    span_hours = (readings[-1].timestamp - readings[0].timestamp).total_seconds() / 3600.0
    total_minutes = observed_minutes + gap_minutes

    daily_rows: list[dict[str, Any]] = []
    for date_key in sorted(daily):
        values = daily[date_key]
        known = values["observed_minutes"] + values["gap_minutes"]
        daily_rows.append({
            "date": date_key,
            # Floored at display time only. A day can only net negative through
            # reading noise, and "-1 L consumed" is a lie the chart would tell.
            "liters": max(0, round(values["liters"])),
            "gap_liters": max(0, round(values["gap_liters"])),
            "observed_pct": round(100.0 * values["observed_minutes"] / known, 1) if known else 0.0,
        })

    hourly_rows: list[dict[str, Any]] = []
    for hour in range(24):
        bucket = hourly[hour]
        rate = None
        if bucket["observed_minutes"] >= 30:
            rate = max(0.0, round(bucket["liters"] / (bucket["observed_minutes"] / 60.0), 2))
        hourly_rows.append({
            "hour": hour,
            "liters": max(0, round(bucket["liters"])),
            "observed_minutes": round(bucket["observed_minutes"]),
            "liters_per_observed_hour": rate,
        })

    return {
        "span": {
            "from": readings[0].timestamp.strftime(TIMESTAMP_FORMAT),
            "to": readings[-1].timestamp.strftime(TIMESTAMP_FORMAT),
            "hours": round(span_hours, 1),
        },
        "coverage": {
            "observed_minutes": round(observed_minutes),
            "gap_minutes": round(gap_minutes),
            "absence_minutes": round(absence_minutes),
            "outage_minutes": round(outage_minutes),
            "observed_pct": round(100.0 * observed_minutes / total_minutes, 1) if total_minutes else 0.0,
            # Coverage with planned absences taken out of the denominator. This is
            # the number that says whether the capture pipeline is healthy; the raw
            # one above says how much of the calendar has data.
            "observed_pct_excl_absence": round(
                100.0 * observed_minutes / (total_minutes - absence_minutes), 1
            ) if (total_minutes - absence_minutes) > 0 else 0.0,
            "gap_count": gap_count,
            "absence_count": sum(1 for g in gaps if g["kind"] == "absence"),
            "outage_count": sum(1 for g in gaps if g["kind"] == "outage"),
        },
        "volume": {
            # The meter is cumulative, so the endpoint difference IS the total --
            # no summation needed and no rounding to accumulate. observed/gap split
            # it by where the water flowed, and the two add back to it.
            "total_liters": readings[-1].reading_liters - readings[0].reading_liters,
            "observed_liters": round(observed_liters),
            "gap_liters": round(gap_liters),
            "absence_liters": max(0, round(absence_liters)),
            "outage_liters": max(0, round(outage_liters)),
        },
        # Longest first, capped: the UI shows a handful and the rest is noise.
        "gaps": sorted(gaps, key=lambda g: -g["hours"])[:8],
        "daily": daily_rows,
        "hourly": hourly_rows,
        # { "2026-09-16": [0, 0, 12, ...] } - 24 posicoes por dia, em litros.
        #
        # SEM piso em zero, e de proposito - pelo mesmo motivo que o comentario
        # dos deltas signed la em cima explica. Uma hora pode ficar levemente
        # negativa por ruido da roda do milesimo e a hora seguinte recuperar.
        # Zerando hora a hora, a recuperacao e contada e a queda nao, e a soma
        # sobe sozinha: na serie real isso inflava 14/09 de 157 para 187 L.
        #
        # Signed, os valores telescopam e a soma das 24 horas bate com a parte
        # observada do dia. Quem desenha a barra que corte em zero na exibicao;
        # o numero guardado aqui continua honesto.
        "hourly_by_day": {
            dia: [round(valor) for valor in valores]
            for dia, valores in sorted(by_day_hour.items())
        },
    }


# ---------------------------------------------------------------------------
# Per-room processing
# ---------------------------------------------------------------------------

def process_room(room_key: str, source: Path, logger: RunLogger) -> RoomResult:
    """Read, clean, analyse and persist one room. Never raises."""
    if not source.exists():
        logger.log(f"room={room_key} status=absent (no source at {source})")
        return RoomResult(room_key=room_key, has_data=False)

    try:
        frame = read_excel_with_retry(source, logger, room_key)
        clean = clean_readings(frame)
    except ExcelUnavailable as exc:
        logger.log(f"room={room_key} status=SKIPPED reason={exc}")
        return RoomResult(room_key=room_key, has_data=False, error=str(exc))
    except Exception as exc:  # noqa: BLE001 -- one bad room must not kill the run
        logger.log(
            f"room={room_key} status=SKIPPED unexpected={type(exc).__name__}: {exc}"
        )
        return RoomResult(room_key=room_key, has_data=False, error=str(exc))

    if not clean.readings:
        logger.log(
            f"room={room_key} status=empty rows_read={clean.rows_read} "
            f"rejected={clean.rejected_total} sessions=0"
        )
        return RoomResult(room_key=room_key, has_data=False, clean=clean)

    sessions, outages = detect_sessions(room_key, clean.readings)
    room_dir = DATA_ROOT / room_key

    try:
        months = write_monthly_shards(room_dir, clean.readings, logger)
        newest = clean.readings[-1]
        write_json(
            room_dir / "latest.json",
            {
                "room_key": room_key,
                "timestamp": newest.timestamp.strftime(TIMESTAMP_FORMAT),
                "reading": newest.reading_m3,
            },
        )
        write_json(room_dir / "daily.json", build_daily_summary(sessions))
        analysis = build_volume_analysis(clean.readings)
        write_json(room_dir / "analysis.json", analysis)
    except OSError as exc:
        logger.log(f"room={room_key} status=SKIPPED write_failed={exc}")
        return RoomResult(room_key=room_key, has_data=False, clean=clean, error=str(exc))

    logger.log(
        f"room={room_key} status=ok rows_read={clean.rows_read} "
        f"accepted={len(clean.readings)} rejected={clean.rejected_total} "
        f"(unparsable={clean.rejected_unparsable} backwards={clean.rejected_backwards} "
        f"jump={clean.rejected_jump} rate={clean.rejected_rate} "
        # spike e o guarda de confirmacao; aguardando sao os saltos recentes
        # demais para julgar, que voltam a ser avaliados na proxima rodada.
        f"spike={clean.rejected_spike}) aguardando={clean.pendente_confirmacao} "
        f"sessions={len(sessions)} "
        f"banhos={sum(1 for s in sessions if s.session_type == 'banho')} "
        f"descargas={sum(1 for s in sessions if s.session_type == 'descarga')} "
        f"outages={outages} months={','.join(months) or '-'} "
        f"observed={analysis.get('coverage', {}).get('observed_pct', 0)}% "
        f"(excl_absence={analysis.get('coverage', {}).get('observed_pct_excl_absence', 0)}%) "
        f"volume={analysis.get('volume', {}).get('total_liters', 0)}L "
        f"gap={analysis.get('volume', {}).get('gap_liters', 0)}L "
        f"last={newest.reading_m3}"
    )

    result = RoomResult(room_key=room_key, has_data=True, clean=clean, sessions=sessions)
    result.outages = outages
    return result


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------

def run_git(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Run a git command inside the site repo with a bounded timeout."""
    return subprocess.run(
        ["git", *args],
        cwd=SITE_ROOT,
        capture_output=True,
        text=True,
        timeout=GIT_TIMEOUT_SECONDS,
        check=False,
    )


def ensure_repo(logger: RunLogger) -> bool:
    """Initialise the repo on first run. Returns False if git is unusable."""
    if (SITE_ROOT / ".git").exists():
        return True
    result = run_git(["init"])
    if result.returncode != 0:
        logger.log(f"git=init_failed {result.stderr.strip()}")
        return False
    logger.log("git=initialised")
    return True


def changed_paths(logger: RunLogger) -> list[str] | None:
    """Repo-relative paths with staged or unstaged changes. None if git failed."""
    result = run_git(["status", "--porcelain"])
    if result.returncode != 0:
        logger.log(f"git=status_failed {result.stderr.strip()}")
        return None
    # Porcelain v1 format: two status chars, a space, then the path.
    return [line[3:].strip() for line in result.stdout.splitlines() if line.strip()]


def manifest_diff_is_timestamp_only() -> bool:
    """True when the staged manifest differs from HEAD only in its sync timestamps.

    manifest.json carries last_sync/generated_at, which change on every single run.
    Without this check an hourly Scheduled Task would commit ~24 times a day purely
    to bump a clock, burying real consumption changes in noise.
    """
    result = run_git(["diff", "--cached", "--unified=0", "--", MANIFEST_REL_PATH])
    if result.returncode != 0:
        return False  # cannot prove it is noise, so treat it as a real change

    for line in result.stdout.splitlines():
        if line.startswith(("+++", "---", "@@", "diff ", "index ", "new file")):
            continue
        if line.startswith(("+", "-")):
            body = line[1:].strip()
            if not any(key in body for key in VOLATILE_MANIFEST_KEYS):
                return False
    return True


def has_remote() -> bool:
    result = run_git(["remote"])
    return result.returncode == 0 and bool(result.stdout.strip())


def commit_and_push(logger: RunLogger, run_started: datetime) -> int:
    """Stage, commit and push. Returns the process exit code to use.

    An empty commit is skipped. A missing remote is NOT an error -- the remote is
    wired up separately, and until then a successful local commit is a full success.
    """
    if not ensure_repo(logger):
        return 1

    add = run_git(["add", "-A"])
    if add.returncode != 0:
        logger.log(f"git=add_failed {add.stderr.strip()}")
        return 1

    changed = changed_paths(logger)
    if changed is None:
        return 1

    if not changed:
        logger.log("git=no_changes push=skipped")
        return 0

    if changed == [MANIFEST_REL_PATH] and manifest_diff_is_timestamp_only():
        # Nothing but the clock moved. Unstage and discard so the working tree stays
        # identical to HEAD and the next run compares against a stable baseline.
        run_git(["restore", "--staged", "--worktree", "--", MANIFEST_REL_PATH])
        logger.log("git=no_data_changes push=skipped (manifest timestamp only)")
        return 0

    message = f"sync: {run_started.astimezone(timezone.utc).isoformat()}"
    commit = run_git(["commit", "-m", message])
    if commit.returncode != 0:
        logger.log(f"git=commit_failed {(commit.stderr or commit.stdout).strip()}")
        return 1
    logger.log(f"git=committed message='{message}'")

    if not has_remote():
        logger.log("git=no_remote push=skipped (configure a remote to enable push)")
        return 0

    push = run_git(["push"])
    if push.returncode != 0:
        logger.log(f"git=push_FAILED {(push.stderr or push.stdout).strip()}")
        return 1

    logger.log("git=pushed")
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def build_manifest(results: list[RoomResult], last_sync: str) -> dict[str, Any]:
    rooms: list[dict[str, Any]] = []
    for result in results:
        room_dir = DATA_ROOT / result.room_key
        entry: dict[str, Any] = {
            "room_key": result.room_key,
            "label": ROOM_LABELS[result.room_key],
            "temperature": "quente" if result.room_key.endswith("_quente") else "fria",
            "has_data": result.has_data,
            "last_reading": None,
            "last_reading_at": None,
            "last_sync": last_sync,
            "available_months": [],
        }
        if result.has_data and result.clean is not None and result.clean.readings:
            newest = result.clean.readings[-1]
            entry["last_reading"] = newest.reading_m3
            entry["last_reading_at"] = newest.timestamp.strftime(TIMESTAMP_FORMAT)
            entry["available_months"] = sorted(
                path.stem
                for path in room_dir.glob("*.json")
                if path.stem not in {"latest", "daily"}
            )
        rooms.append(entry)
    return {"generated_at": last_sync, "rooms": rooms}


def main() -> int:
    run_started = datetime.now().astimezone()
    logger = RunLogger(LOG_PATH, run_started)
    last_sync = run_started.isoformat()

    logger.log(f"run=start rooms={len(ROOM_SOURCES)}")
    DATA_ROOT.mkdir(parents=True, exist_ok=True)

    results = [
        process_room(room_key, source, logger)
        for room_key, source in ROOM_SOURCES.items()
    ]

    try:
        write_json(DATA_ROOT / "manifest.json", build_manifest(results, last_sync))
    except OSError as exc:
        logger.log(f"run=ABORTED manifest_write_failed={exc}")
        return 2

    with_data = sum(1 for result in results if result.has_data)
    skipped = sum(1 for result in results if result.error)
    logger.log(f"manifest=written rooms_with_data={with_data} rooms_skipped={skipped}")

    exit_code = commit_and_push(logger, run_started)
    duration = (datetime.now().astimezone() - run_started).total_seconds()
    logger.log(f"run=end exit={exit_code} duration={duration:.1f}s")
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 -- Scheduled Task must never see a raw traceback
        stamp = datetime.now().strftime(TIMESTAMP_FORMAT)
        detail = traceback.format_exc()
        print(f"[{stamp}] run=CRASHED\n{detail}", flush=True)
        try:
            with LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(f"[{stamp}] run=CRASHED\n{detail}\n")
        except OSError:
            pass
        sys.exit(2)
