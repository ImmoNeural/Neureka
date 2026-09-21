#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for sync_to_site.py.

Run from the repo root:

    py -3.13 -m unittest discover -s tests -v

Uses only the standard library plus pandas (already a dependency of the script).
Nothing here reads or writes the live Ch.Hiller pipeline.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sync_to_site as sync  # noqa: E402


def ts(text: str) -> datetime:
    return datetime.strptime(text, sync.TIMESTAMP_FORMAT)


def frame(rows: list[tuple[str, object]]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            sync.COL_TIMESTAMP: [row[0] for row in rows],
            sync.COL_READING: [row[1] for row in rows],
        }
    )


def readings(rows: list[tuple[str, float]]) -> list[sync.Reading]:
    return [
        sync.Reading(
            timestamp=ts(stamp),
            reading_m3=value,
            reading_liters=int(round(value * 1000)),
        )
        for stamp, value in rows
    ]


class SilentLogger(sync.RunLogger):
    """RunLogger that captures lines instead of touching stdout or the log file."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def log(self, message: str) -> None:
        self.lines.append(message)


# ---------------------------------------------------------------------------
# clean_readings
# ---------------------------------------------------------------------------

class CleanReadingsTest(unittest.TestCase):
    def test_accepts_flat_and_rising_series(self) -> None:
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:10:26", 134.463),
                    ("2026-08-30 22:14:10", 134.463),
                    ("2026-08-30 22:21:00", 134.470),
                ]
            )
        )
        self.assertEqual([r.reading_m3 for r in result.readings], [134.463, 134.463, 134.470])
        self.assertEqual(result.rejected_total, 0)

    def test_rejects_reading_below_last_good(self) -> None:
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:10:00", 134.500),
                    ("2026-08-30 22:15:00", 134.400),
                    ("2026-08-30 22:20:00", 134.505),
                ]
            )
        )
        self.assertEqual(result.rejected_backwards, 1)
        self.assertEqual([r.reading_m3 for r in result.readings], [134.500, 134.505])

    def test_rejects_ocr_spike_by_flow_rate(self) -> None:
        """The real 134.463 -> 134.641 misread: 178 L in 3.28 min = 54 L/min."""
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:21:53", 134.463),
                    ("2026-08-30 22:25:10", 134.641),
                ]
            )
        )
        self.assertEqual(result.rejected_rate, 1)
        self.assertEqual([r.reading_m3 for r in result.readings], [134.463])

    def test_rate_guard_allows_realistic_shower_draw(self) -> None:
        """17 L/min is a genuine draw and must survive.

        As tres leituras do fim nao sao enfeite: 61 L passa de
        SALTO_SUSPEITO_LITROS, entao o salto so e publicado depois que elas
        confirmam que o relogio ficou la em cima.
        """
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:32:34", 134.424),
                    ("2026-08-30 22:36:07", 134.485),  # 61 L in 3.55 min = 17.2 L/min
                    ("2026-08-30 22:46:00", 134.485),
                    ("2026-08-30 22:56:00", 134.486),
                    ("2026-08-30 23:06:00", 134.486),
                ]
            )
        )
        self.assertEqual(result.rejected_total, 0)
        self.assertEqual(result.pendente_confirmacao, 0)
        self.assertEqual(len(result.readings), 5)

    def test_shower_is_held_until_three_readings_confirm_it(self) -> None:
        """Um salto real, mas recente demais, espera em vez de ser publicado."""
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:32:34", 134.424),
                    ("2026-08-30 22:36:07", 134.485),
                ]
            )
        )
        # Retido, nao rejeitado: a diferenca importa, porque na proxima rodada
        # ele volta a ser avaliado com as leituras que faltavam.
        self.assertEqual(result.rejected_spike, 0)
        self.assertEqual(result.pendente_confirmacao, 1)
        self.assertEqual(len(result.readings), 1)

    def test_spike_contradicted_by_the_next_reading_is_dropped(self) -> None:
        """O caso real de 17/09: sobe 420 L e a leitura seguinte volta."""
        result = sync.clean_readings(
            frame(
                [
                    ("2026-09-17 09:14:00", 187.045),
                    ("2026-09-17 09:36:00", 187.045),
                    ("2026-09-17 09:58:00", 187.465),  # +420 L -- misread
                    ("2026-09-17 10:20:00", 187.045),
                    ("2026-09-17 10:42:00", 187.045),
                    ("2026-09-17 11:03:00", 187.045),
                ]
            )
        )
        self.assertEqual(result.rejected_spike, 1)
        self.assertNotIn(187.465, [r.reading_m3 for r in result.readings])
        # O pico sai e os vizinhos ficam.
        self.assertEqual(len(result.readings), 5)

    def test_slow_misread_under_the_rate_ceiling_is_caught(self) -> None:
        """O buraco que existia: 430 L em 72 min dao 5,97 L/min e passavam.

        O guarda de vazao pergunta se a agua CABE no tempo decorrido. Diluido
        num intervalo longo, um misread grande cabe. Quem pega e a confirmacao.
        """
        result = sync.clean_readings(
            frame(
                [
                    ("2026-09-15 19:12:00", 135.125),
                    ("2026-09-15 20:24:00", 135.555),  # +430 L em 72 min
                    ("2026-09-15 20:46:00", 135.153),
                    ("2026-09-15 21:08:00", 135.153),
                    ("2026-09-15 21:30:00", 135.153),
                ]
            )
        )
        self.assertEqual(result.rejected_rate, 0, "a vazao nao pega este caso")
        self.assertEqual(result.rejected_spike, 1, "a confirmacao pega")
        self.assertNotIn(135.555, [r.reading_m3 for r in result.readings])

    def test_rise_of_exactly_the_threshold_is_not_quarantined(self) -> None:
        """Subida de exatos 20 L passa direto - o caso real de 21/09/2026.

        135.585 - 135.565 nao da 0.020 em ponto flutuante, da
        0.020000000000010232, que vezes mil e maior que 20 por uma parte em dois
        trilhoes. Sem arredondar para litro inteiro antes de comparar, uma
        subida banal caia em quarentena e a publicacao da agua quente parava
        por horas esperando confirmacoes que nao vinham.

        Os valores aqui sao os da serie real, de proposito: um teste com
        numeros redondos inventados nao reproduziria o erro.
        """
        result = sync.clean_readings(
            frame(
                [
                    ("2026-09-21 09:01:00", 135.565),
                    ("2026-09-21 11:00:00", 135.585),
                ]
            )
        )
        self.assertEqual(result.pendente_confirmacao, 0, "nao deveria esperar")
        self.assertEqual(result.rejected_total, 0)
        self.assertEqual([r.reading_m3 for r in result.readings], [135.565, 135.585])

    def test_one_litre_above_the_threshold_still_waits(self) -> None:
        """E o limite continua valendo: 21 L entra em quarentena."""
        result = sync.clean_readings(
            frame(
                [
                    ("2026-09-21 09:01:00", 135.565),
                    ("2026-09-21 11:00:00", 135.586),
                ]
            )
        )
        self.assertEqual(result.pendente_confirmacao, 1)
        self.assertEqual(len(result.readings), 1)

    def test_small_rise_is_published_without_waiting(self) -> None:
        """Abaixo do limite nao ha quarentena: o caso comum segue direto."""
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:00:00", 134.000),
                    ("2026-08-30 22:10:00", 134.015),  # +15 L
                ]
            )
        )
        self.assertEqual(result.rejected_total, 0)
        self.assertEqual(result.pendente_confirmacao, 0)
        self.assertEqual(len(result.readings), 2)

    def test_absolute_jump_guard_bounds_long_outage(self) -> None:
        """Across a 14-hour gap the rate guard is permissive, so the absolute cap runs."""
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:44:40", 134.483),
                    ("2026-08-31 12:57:13", 200.000),  # +65.5 m3, rate only 0.08 L/min
                ]
            )
        )
        self.assertEqual(result.rejected_jump, 1)
        self.assertEqual(result.rejected_rate, 0)
        self.assertEqual([r.reading_m3 for r in result.readings], [134.483])

    def test_rejection_does_not_advance_last_known_good(self) -> None:
        """A rejected spike must not become the baseline for later comparisons."""
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:21:53", 134.463),
                    ("2026-08-30 22:25:10", 134.641),  # rejected: 54 L/min
                    ("2026-08-30 22:28:50", 134.464),  # must be accepted, not "backwards"
                ]
            )
        )
        self.assertEqual([r.reading_m3 for r in result.readings], [134.463, 134.464])

    def test_rejects_unparsable_rows(self) -> None:
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:10:00", 134.500),
                    ("not-a-timestamp", 134.501),
                    ("2026-08-30 22:20:00", "não-é-número"),
                    ("2026-08-30 22:30:00", 134.502),
                ]
            )
        )
        self.assertEqual(result.rejected_unparsable, 2)
        self.assertEqual([r.reading_m3 for r in result.readings], [134.500, 134.502])

    def test_sorts_out_of_order_rows_before_validating(self) -> None:
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:30:00", 134.502),
                    ("2026-08-30 22:10:00", 134.500),
                    ("2026-08-30 22:20:00", 134.501),
                ]
            )
        )
        self.assertEqual([r.reading_m3 for r in result.readings], [134.500, 134.501, 134.502])
        self.assertEqual(result.rejected_total, 0)

    def test_accepts_real_datetime_column(self) -> None:
        """A workbook re-saved by Excel can return datetimes instead of strings."""
        result = sync.clean_readings(
            frame([(pd.Timestamp("2026-08-30 22:10:00"), 134.5)])  # type: ignore[list-item]
        )
        self.assertEqual(len(result.readings), 1)

    def test_missing_required_column_raises_excel_unavailable(self) -> None:
        with self.assertRaises(sync.ExcelUnavailable):
            sync.clean_readings(pd.DataFrame({"Arquivo": ["a.jpg"]}))

    def test_duplicate_timestamps_do_not_divide_by_zero(self) -> None:
        result = sync.clean_readings(
            frame(
                [
                    ("2026-08-30 22:10:00", 134.500),
                    ("2026-08-30 22:10:00", 134.501),
                ]
            )
        )
        self.assertEqual(len(result.readings), 2)

    def test_empty_frame_yields_no_readings(self) -> None:
        result = sync.clean_readings(frame([]))
        self.assertEqual(result.readings, [])
        self.assertEqual(result.rows_read, 0)


# ---------------------------------------------------------------------------
# classify_session
# ---------------------------------------------------------------------------

class ClassifySessionTest(unittest.TestCase):
    def test_small_cold_draw_is_descarga(self) -> None:
        self.assertEqual(sync.classify_session("banheiro_fria", 9), "descarga")

    def test_cold_draw_at_threshold_is_not_descarga(self) -> None:
        self.assertEqual(
            sync.classify_session("banheiro_fria", sync.FLUSH_VOLUME_LITERS), "uso"
        )

    def test_large_hot_draw_is_banho(self) -> None:
        self.assertEqual(sync.classify_session("banheiro_quente", 40), "banho")

    def test_hot_draw_at_threshold_is_banho(self) -> None:
        self.assertEqual(
            sync.classify_session("banheiro_quente", sync.FLUSH_VOLUME_LITERS), "banho"
        )

    def test_small_hot_draw_is_uso(self) -> None:
        self.assertEqual(sync.classify_session("banheiro_quente", 3), "uso")

    def test_large_cold_draw_is_uso(self) -> None:
        self.assertEqual(sync.classify_session("lavanderia_fria", 60), "uso")

    def test_classification_uses_suffix_not_room_name(self) -> None:
        """Kitchen and laundry classify on the same rule as the bathroom."""
        self.assertEqual(sync.classify_session("cozinha_quente", 30), "banho")
        self.assertEqual(sync.classify_session("cozinha_fria", 5), "descarga")


# ---------------------------------------------------------------------------
# detect_sessions
# ---------------------------------------------------------------------------

class DetectSessionsTest(unittest.TestCase):
    def test_consecutive_rising_readings_form_one_session(self) -> None:
        sessions, outages = sync.detect_sessions(
            "banheiro_quente",
            readings(
                [
                    ("2026-08-30 22:00:00", 134.000),
                    ("2026-08-30 22:05:00", 134.020),
                    ("2026-08-30 22:10:00", 134.045),
                ]
            ),
        )
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].volume_liters, 45)
        self.assertEqual(sessions[0].start_time, ts("2026-08-30 22:00:00"))
        self.assertEqual(sessions[0].end_time, ts("2026-08-30 22:10:00"))
        self.assertEqual(sessions[0].session_type, "banho")
        self.assertEqual(outages, 0)

    def test_flat_delta_closes_the_session(self) -> None:
        sessions, _ = sync.detect_sessions(
            "banheiro_quente",
            readings(
                [
                    ("2026-08-30 22:00:00", 134.000),
                    ("2026-08-30 22:05:00", 134.020),
                    ("2026-08-30 22:10:00", 134.020),  # flow stopped
                    ("2026-08-30 22:15:00", 134.050),  # new session
                ]
            ),
        )
        self.assertEqual([s.volume_liters for s in sessions], [20, 30])

    def test_gap_beyond_merge_window_splits_sessions(self) -> None:
        sessions, outages = sync.detect_sessions(
            "banheiro_quente",
            readings(
                [
                    ("2026-08-30 22:00:00", 134.000),
                    ("2026-08-30 22:05:00", 134.020),
                    ("2026-08-30 22:35:00", 134.060),  # 30 min: > MERGE, < MAX
                    ("2026-08-30 22:40:00", 134.080),
                ]
            ),
        )
        self.assertEqual([s.volume_liters for s in sessions], [20, 20])
        self.assertEqual(outages, 0, "30 min is a split, not a capture outage")

    def test_outage_gap_is_counted_and_never_merged(self) -> None:
        sessions, outages = sync.detect_sessions(
            "banheiro_quente",
            readings(
                [
                    ("2026-08-30 22:40:00", 134.483),
                    ("2026-08-31 12:57:00", 134.484),  # ~14 h pipeline outage
                    ("2026-08-31 13:05:00", 134.519),
                ]
            ),
        )
        self.assertEqual(outages, 1)
        self.assertEqual([s.volume_liters for s in sessions], [35])
        self.assertNotIn(
            1001, [s.volume_liters for s in sessions], "outage must not become one session"
        )

    def test_single_reading_produces_no_session(self) -> None:
        sessions, outages = sync.detect_sessions(
            "banheiro_quente", readings([("2026-08-30 22:00:00", 134.0)])
        )
        self.assertEqual(sessions, [])
        self.assertEqual(outages, 0)

    def test_entirely_flat_series_produces_no_session(self) -> None:
        sessions, _ = sync.detect_sessions(
            "banheiro_quente",
            readings(
                [
                    ("2026-08-30 22:00:00", 134.0),
                    ("2026-08-30 22:05:00", 134.0),
                    ("2026-08-30 22:10:00", 134.0),
                ]
            ),
        )
        self.assertEqual(sessions, [])

    def test_open_session_at_end_of_series_is_closed(self) -> None:
        sessions, _ = sync.detect_sessions(
            "banheiro_quente",
            readings(
                [
                    ("2026-08-30 22:00:00", 134.000),
                    ("2026-08-30 22:05:00", 134.030),
                ]
            ),
        )
        self.assertEqual(len(sessions), 1, "a session still open at the end must be emitted")
        self.assertEqual(sessions[0].volume_liters, 30)

    def test_volume_is_exact_integer_litres(self) -> None:
        """Float m3 subtraction drifts; integer litres must not."""
        sessions, _ = sync.detect_sessions(
            "banheiro_quente",
            readings(
                [
                    ("2026-08-30 22:00:00", 134.519),
                    ("2026-08-30 22:05:00", 134.520),
                ]
            ),
        )
        self.assertEqual(sessions[0].volume_liters, 1)


# ---------------------------------------------------------------------------
# build_daily_summary
# ---------------------------------------------------------------------------

class DailySummaryTest(unittest.TestCase):
    def test_counts_and_averages_per_day(self) -> None:
        sessions = [
            sync.Session(ts("2026-08-30 07:00:00"), ts("2026-08-30 07:10:00"), 40, "banho"),
            sync.Session(ts("2026-08-30 19:00:00"), ts("2026-08-30 19:10:00"), 60, "banho"),
            sync.Session(ts("2026-08-30 20:00:00"), ts("2026-08-30 20:05:00"), 8, "descarga"),
            sync.Session(ts("2026-08-31 09:00:00"), ts("2026-08-31 09:05:00"), 3, "uso"),
        ]
        daily = sync.build_daily_summary(sessions)
        self.assertEqual([d["date"] for d in daily], ["2026-08-30", "2026-08-31"])

        day_one = daily[0]
        self.assertEqual(day_one["session_count"], 3)
        self.assertEqual(day_one["banho_count"], 2)
        self.assertEqual(day_one["descarga_count"], 1)
        self.assertEqual(day_one["total_liters"], 108)
        self.assertEqual(day_one["avg_liters_per_banho"], 50.0)
        self.assertEqual(day_one["avg_liters_per_descarga"], 8.0)

        day_two = daily[1]
        self.assertEqual(day_two["session_count"], 1)
        self.assertEqual(day_two["avg_liters_per_banho"], 0.0, "no division by zero")
        self.assertEqual(day_two["avg_liters_per_descarga"], 0.0)

    def test_session_is_attributed_to_its_start_day(self) -> None:
        daily = sync.build_daily_summary(
            [sync.Session(ts("2026-08-30 23:55:00"), ts("2026-08-31 00:05:00"), 30, "banho")]
        )
        self.assertEqual([d["date"] for d in daily], ["2026-08-30"])

    def test_no_sessions_yields_empty_list(self) -> None:
        self.assertEqual(sync.build_daily_summary([]), [])


# ---------------------------------------------------------------------------
# Monthly shards
# ---------------------------------------------------------------------------

class MonthlyShardTest(unittest.TestCase):
    def test_rerunning_does_not_duplicate_points(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            room_dir = Path(tmp)
            logger = SilentLogger()
            series = readings(
                [("2026-08-30 22:00:00", 134.0), ("2026-08-30 22:05:00", 134.02)]
            )

            sync.write_monthly_shards(room_dir, series, logger)
            sync.write_monthly_shards(room_dir, series, logger)

            payload = json.loads((room_dir / "2026-08.json").read_text(encoding="utf-8"))
            self.assertEqual(len(payload), 2)
            self.assertEqual(len({p["timestamp"] for p in payload}), 2)

    def test_shard_is_rebuilt_from_source_when_cleaning_changes(self) -> None:
        """A previously accepted bad point must not be pinned into the archive."""
        with tempfile.TemporaryDirectory() as tmp:
            room_dir = Path(tmp)
            logger = SilentLogger()
            (room_dir / "2026-08.json").write_text(
                json.dumps(
                    [
                        {"timestamp": "2026-08-30 22:00:00", "reading": 134.0},
                        {"timestamp": "2026-08-30 22:25:10", "reading": 134.641},
                    ]
                ),
                encoding="utf-8",
            )

            sync.write_monthly_shards(
                room_dir, readings([("2026-08-30 22:00:00", 134.0)]), logger
            )

            payload = json.loads((room_dir / "2026-08.json").read_text(encoding="utf-8"))
            self.assertEqual([p["reading"] for p in payload], [134.0])

    def test_points_split_across_month_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            room_dir = Path(tmp)
            months = sync.write_monthly_shards(
                room_dir,
                readings([("2026-08-31 23:50:00", 134.0), ("2026-09-01 00:10:00", 134.01)]),
                SilentLogger(),
            )
            self.assertEqual(months, ["2026-08", "2026-09"])
            self.assertTrue((room_dir / "2026-08.json").exists())
            self.assertTrue((room_dir / "2026-09.json").exists())

    def test_corrupt_existing_shard_is_rebuilt_not_fatal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            room_dir = Path(tmp)
            (room_dir / "2026-08.json").write_text("{ not json", encoding="utf-8")
            sync.write_monthly_shards(
                room_dir, readings([("2026-08-30 22:00:00", 134.0)]), SilentLogger()
            )
            payload = json.loads((room_dir / "2026-08.json").read_text(encoding="utf-8"))
            self.assertEqual(len(payload), 1)

    def test_untouched_months_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            room_dir = Path(tmp)
            (room_dir / "2026-07.json").write_text(
                json.dumps([{"timestamp": "2026-07-01 10:00:00", "reading": 130.0}]),
                encoding="utf-8",
            )
            sync.write_monthly_shards(
                room_dir, readings([("2026-08-30 22:00:00", 134.0)]), SilentLogger()
            )
            payload = json.loads((room_dir / "2026-07.json").read_text(encoding="utf-8"))
            self.assertEqual(payload[0]["reading"], 130.0)


# ---------------------------------------------------------------------------
# Excel reading resilience
# ---------------------------------------------------------------------------

class ExcelResilienceTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.object(sync, "EXCEL_RETRY_BACKOFF_SECONDS", (0.0, 0.0))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _workbook(self, directory: Path) -> Path:
        path = directory / sync.EXCEL_FILENAME
        pd.DataFrame(
            {
                sync.COL_TIMESTAMP: ["2026-08-30 22:10:26"],
                sync.COL_READING: [134.463],
            }
        ).to_excel(path, index=False)
        return path

    def test_retries_then_succeeds_when_lock_clears(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._workbook(Path(tmp))
            real_copy = sync.shutil.copy2
            calls = {"n": 0}

            def flaky(src, dst, **kwargs):  # type: ignore[no-untyped-def]
                calls["n"] += 1
                if calls["n"] == 1:
                    raise PermissionError(32, "file is in use by another process")
                return real_copy(src, dst, **kwargs)

            with mock.patch.object(sync.shutil, "copy2", side_effect=flaky):
                result = sync.read_excel_with_retry(path, SilentLogger(), "banheiro_quente")

            self.assertEqual(calls["n"], 2)
            self.assertEqual(len(result), 1)

    def test_raises_excel_unavailable_after_exhausting_retries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._workbook(Path(tmp))
            with mock.patch.object(
                sync.shutil, "copy2", side_effect=PermissionError(32, "locked")
            ):
                with self.assertRaises(sync.ExcelUnavailable):
                    sync.read_excel_with_retry(path, SilentLogger(), "banheiro_quente")

    def test_attempts_exactly_the_configured_number_of_times(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._workbook(Path(tmp))
            with mock.patch.object(
                sync.shutil, "copy2", side_effect=PermissionError(32, "locked")
            ) as copier:
                with self.assertRaises(sync.ExcelUnavailable):
                    sync.read_excel_with_retry(path, SilentLogger(), "banheiro_quente")
            self.assertEqual(copier.call_count, sync.EXCEL_READ_ATTEMPTS)

    def test_corrupt_workbook_raises_excel_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / sync.EXCEL_FILENAME
            path.write_text("this is not a zip archive", encoding="utf-8")
            with self.assertRaises(sync.ExcelUnavailable):
                sync.read_excel_with_retry(path, SilentLogger(), "banheiro_quente")


# ---------------------------------------------------------------------------
# process_room -- one bad room must never abort the run
# ---------------------------------------------------------------------------

class ProcessRoomTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        patcher = mock.patch.object(sync, "DATA_ROOT", self.root / "data")
        patcher.start()
        self.addCleanup(patcher.stop)
        backoff = mock.patch.object(sync, "EXCEL_RETRY_BACKOFF_SECONDS", (0.0, 0.0))
        backoff.start()
        self.addCleanup(backoff.stop)

    def test_absent_source_reports_no_data_without_error(self) -> None:
        result = sync.process_room(
            "cozinha_fria", self.root / "nope" / sync.EXCEL_FILENAME, SilentLogger()
        )
        self.assertFalse(result.has_data)
        self.assertIsNone(result.error)

    def test_locked_source_is_skipped_not_fatal(self) -> None:
        path = self.root / sync.EXCEL_FILENAME
        pd.DataFrame(
            {sync.COL_TIMESTAMP: ["2026-08-30 22:10:26"], sync.COL_READING: [134.463]}
        ).to_excel(path, index=False)

        with mock.patch.object(
            sync.shutil, "copy2", side_effect=PermissionError(32, "locked by Excel")
        ):
            result = sync.process_room("banheiro_quente", path, SilentLogger())

        self.assertFalse(result.has_data)
        self.assertIsNotNone(result.error)

    def test_wrong_schema_is_skipped_not_fatal(self) -> None:
        path = self.root / sync.EXCEL_FILENAME
        pd.DataFrame({"Arquivo": ["foto.jpg"]}).to_excel(path, index=False)
        result = sync.process_room("banheiro_quente", path, SilentLogger())
        self.assertFalse(result.has_data)
        self.assertIsNotNone(result.error)

    def test_valid_source_writes_all_expected_files(self) -> None:
        path = self.root / sync.EXCEL_FILENAME
        pd.DataFrame(
            {
                # As tres ultimas confirmam o salto de 25 L das 22:10 -- sem elas
                # ele ficaria retido e latest.json pararia em 134.020.
                sync.COL_TIMESTAMP: [
                    "2026-08-30 22:00:00",
                    "2026-08-30 22:05:00",
                    "2026-08-30 22:10:00",
                    "2026-08-30 22:15:00",
                    "2026-08-30 22:20:00",
                    "2026-08-30 22:25:00",
                ],
                sync.COL_READING: [
                    134.000, 134.020, 134.045, 134.045, 134.045, 134.046,
                ],
            }
        ).to_excel(path, index=False)

        result = sync.process_room("banheiro_quente", path, SilentLogger())

        self.assertTrue(result.has_data)
        room_dir = sync.DATA_ROOT / "banheiro_quente"
        for name in ("latest.json", "daily.json", "2026-08.json"):
            self.assertTrue((room_dir / name).exists(), f"{name} missing")

        latest = json.loads((room_dir / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(latest["reading"], 134.046)
        self.assertEqual(latest["timestamp"], "2026-08-30 22:25:00")

    def test_empty_workbook_reports_no_data(self) -> None:
        path = self.root / sync.EXCEL_FILENAME
        pd.DataFrame({sync.COL_TIMESTAMP: [], sync.COL_READING: []}).to_excel(
            path, index=False
        )
        result = sync.process_room("banheiro_quente", path, SilentLogger())
        self.assertFalse(result.has_data)
        self.assertIsNone(result.error)


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

class ManifestTest(unittest.TestCase):
    def test_lists_every_configured_room(self) -> None:
        results = [
            sync.RoomResult(room_key=key, has_data=False) for key in sync.ROOM_SOURCES
        ]
        manifest = sync.build_manifest(results, "2026-08-31T15:00:00+02:00")
        self.assertEqual(
            [room["room_key"] for room in manifest["rooms"]], list(sync.ROOM_SOURCES)
        )
        self.assertTrue(all(room["has_data"] is False for room in manifest["rooms"]))
        self.assertTrue(all(room["last_reading"] is None for room in manifest["rooms"]))

    def test_temperature_is_derived_from_the_room_suffix(self) -> None:
        manifest = sync.build_manifest(
            [sync.RoomResult(room_key=key, has_data=False) for key in sync.ROOM_SOURCES],
            "2026-08-31T15:00:00+02:00",
        )
        by_key = {room["room_key"]: room for room in manifest["rooms"]}
        self.assertEqual(by_key["banheiro_quente"]["temperature"], "quente")
        self.assertEqual(by_key["lavanderia_fria"]["temperature"], "fria")

    def test_laundry_has_no_hot_meter_configured(self) -> None:
        self.assertNotIn("lavanderia_quente", sync.ROOM_SOURCES)

    def test_every_room_has_a_display_label(self) -> None:
        self.assertEqual(set(sync.ROOM_LABELS), set(sync.ROOM_SOURCES))



class BackwardsLatchRegressionTest(unittest.TestCase):
    """The gate must never be held shut by a single reading.

    This is a real outage, twice over. On 2026-09-12 the hot meter published one
    reading of 134.966 where the truth was 134.965 -- a single litre, inside the
    noise of the thousandths wheel -- and rejected the next nine correct readings as
    "backwards" for five hours. The anchor was widened to a median, which fixed that
    shape. It did not fix the next one: on 2026-09-13 the cold meter accepted one
    misread of 186.465 as its FIRST reading and then rejected 29 consecutive readings
    of 186.195 across nine hours, because a median window only refreshes when
    something is accepted, and nothing ever was.

    The invariant these tests pin down: readings that corroborate each other beat a
    lone reading that contradicts them, no matter which came first.
    """

    def test_single_misread_never_blocks_a_corroborated_run(self) -> None:
        """The cold meter, 2026-09-13. One bad first reading, 29 good ones after."""
        rows = [("2026-09-13 00:15:34", 186.465)]
        for index in range(6):
            rows.append((f"2026-09-13 0{index + 1}:05:00", 186.195))

        result = sync.clean_readings(frame(rows))
        values = [r.reading_m3 for r in result.readings]

        self.assertNotIn(186.465, values, "the lone misread must not survive")
        self.assertEqual(values.count(186.195), 6, "every corroborated reading counts")
        self.assertEqual(result.readings[-1].reading_m3, 186.195)

    def test_lone_low_reading_without_corroboration_is_still_rejected(self) -> None:
        """The guard against over-correcting: one dip is noise, not consensus."""
        rows = [
            ("2026-09-13 00:00:00", 134.960),
            ("2026-09-13 00:10:00", 134.965),
            ("2026-09-13 00:20:00", 134.965),
            ("2026-09-13 00:30:00", 134.500),  # single misread, 465 L low
            ("2026-09-13 00:40:00", 134.966),
            ("2026-09-13 00:50:00", 134.966),
        ]

        result = sync.clean_readings(frame(rows))
        values = [r.reading_m3 for r in result.readings]

        self.assertNotIn(134.500, values)
        self.assertEqual(result.rejected_backwards, 1)
        self.assertEqual(result.readings[-1].reading_m3, 134.966)

    def test_scattered_low_misreads_do_not_fake_consensus(self) -> None:
        """Three lows that disagree with each other are noise, not a correction."""
        rows = [
            ("2026-09-13 00:00:00", 134.960),
            ("2026-09-13 00:10:00", 134.965),
            ("2026-09-13 00:20:00", 134.965),
            ("2026-09-13 00:30:00", 134.100),
            ("2026-09-13 00:40:00", 134.500),
            ("2026-09-13 00:50:00", 134.300),
        ]

        result = sync.clean_readings(frame(rows))
        values = [r.reading_m3 for r in result.readings]

        for scattered in (134.100, 134.500, 134.300):
            self.assertNotIn(scattered, values)
        self.assertEqual(result.readings[-1].reading_m3, 134.965)

    def test_published_series_never_dips_more_than_the_noise_tolerance(self) -> None:
        """A dip is allowed -- that is what self-healing costs -- but only a small one.

        The anchor is a median, so an accepted reading can sit below its predecessor.
        That is deliberate. What must never happen is a dip large enough to be real
        consumption running backwards, which would mean a misread got published.
        """
        rows = [
            ("2026-09-13 00:00:00", 134.960),
            ("2026-09-13 00:10:00", 134.965),
            ("2026-09-13 00:20:00", 134.975),
            ("2026-09-13 00:30:00", 134.965),
            ("2026-09-13 00:40:00", 134.970),
            ("2026-09-13 00:50:00", 134.968),
        ]

        result = sync.clean_readings(frame(rows))
        litres = [r.reading_liters for r in result.readings]
        worst = max(
            (litres[i - 1] - litres[i] for i in range(1, len(litres))),
            default=0,
        )

        ceiling = int(sync.BACKWARDS_TOLERANCE_M3 * 1000) * 2
        self.assertLessEqual(worst, ceiling, f"queda de {worst} L na serie publicada")

    def test_consensus_requires_the_configured_run_length(self) -> None:
        """A run shorter than REANCHOR_AFTER must not overturn the anchor.

        The gate is the CONSTANT, whatever it is set to -- this test must not pin it
        to a particular number. It asserted `>= 3` until 2026-09-14, when the value
        was deliberately lowered to 2 to cut the exposure window from two hours to
        twenty minutes, and the test failed for being a policy in test clothing
        rather than a behaviour. One reading can never be consensus, so 2 is the
        real floor; anything above it is a tuning decision, not an invariant.
        """
        self.assertGreaterEqual(sync.REANCHOR_AFTER, 2)

        rows = [("2026-09-13 00:00:00", 186.465)]
        for index in range(sync.REANCHOR_AFTER - 1):
            rows.append((f"2026-09-13 00:{(index + 1) * 10:02d}:00", 186.195))

        result = sync.clean_readings(frame(rows))

        self.assertEqual(len(result.readings), 1, "short run must not re-anchor")
        self.assertEqual(result.readings[0].reading_m3, 186.465)


if __name__ == "__main__":
    unittest.main(verbosity=2)
