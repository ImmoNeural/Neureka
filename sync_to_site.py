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
import subprocess
import sys
import tempfile
import time
import traceback
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SITE_ROOT = Path(__file__).resolve().parent
DATA_ROOT = SITE_ROOT / "data"
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
MAX_FLOW_RATE_LITERS_PER_MIN = 25.0

# Two consecutive readings closer together in time than this (and still rising) are
# considered the same continuous draw. Must exceed the camera's capture cadence
# (~5-10 min) or every single reading becomes its own session.
SESSION_MERGE_GAP_MINUTES = 15

# A gap larger than this means the capture pipeline was down (PC asleep, camera
# offline). Any consumption spanning such a gap is NOT attributed to one giant
# session -- the run is closed and the outage is logged.
SESSION_MAX_GAP_MINUTES = 60

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

    @property
    def rejected_total(self) -> int:
        return (
            self.rejected_unparsable
            + self.rejected_backwards
            + self.rejected_jump
            + self.rejected_rate
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
      * below the last ACCEPTED reading (meters do not run backwards),
      * above it by more than MAX_PLAUSIBLE_JUMP_M3 (absolute backstop), or
      * above it fast enough to imply more than MAX_FLOW_RATE_LITERS_PER_MIN.

    Rejection never advances "last known good" -- every later row is still compared
    against the last genuinely trusted value.
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
    last_good_m3: float | None = None
    last_good_ts: datetime | None = None

    for timestamp, reading_m3 in zip(working["_ts"], working["_reading"]):
        value = float(reading_m3)
        moment = timestamp.to_pydatetime()

        if last_good_m3 is not None and last_good_ts is not None:
            if value < last_good_m3:
                rejected_backwards += 1
                continue
            if value - last_good_m3 > MAX_PLAUSIBLE_JUMP_M3:
                rejected_jump += 1
                continue

            elapsed_minutes = (moment - last_good_ts).total_seconds() / 60.0
            # Duplicate timestamps carry no elapsed time, so no rate can be derived;
            # the absolute jump check above is the only guard that applies to them.
            if elapsed_minutes > 0:
                litres_gained = (value - last_good_m3) * 1000.0
                if litres_gained / elapsed_minutes > MAX_FLOW_RATE_LITERS_PER_MIN:
                    rejected_rate += 1
                    continue

        last_good_m3 = value
        last_good_ts = moment
        readings.append(
            Reading(
                timestamp=moment,
                reading_m3=round(value, 3),
                reading_liters=int(round(value * 1000)),
            )
        )

    return CleanResult(
        readings=readings,
        rows_read=rows_read,
        rejected_unparsable=rejected_unparsable,
        rejected_backwards=rejected_backwards,
        rejected_jump=rejected_jump,
        rejected_rate=rejected_rate,
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
    except OSError as exc:
        logger.log(f"room={room_key} status=SKIPPED write_failed={exc}")
        return RoomResult(room_key=room_key, has_data=False, clean=clean, error=str(exc))

    logger.log(
        f"room={room_key} status=ok rows_read={clean.rows_read} "
        f"accepted={len(clean.readings)} rejected={clean.rejected_total} "
        f"(unparsable={clean.rejected_unparsable} backwards={clean.rejected_backwards} "
        f"jump={clean.rejected_jump} rate={clean.rejected_rate}) sessions={len(sessions)} "
        f"banhos={sum(1 for s in sessions if s.session_type == 'banho')} "
        f"descargas={sum(1 for s in sessions if s.session_type == 'descarga')} "
        f"outages={outages} months={','.join(months) or '-'} "
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
