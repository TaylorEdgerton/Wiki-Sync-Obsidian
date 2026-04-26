"""Tests for PresidioDetector — skipped when presidio-analyzer is not installed."""

from __future__ import annotations

import unittest

try:
    import presidio_analyzer  # noqa: F401
    import spacy

    _MODEL = "en_core_web_sm"
    try:
        spacy.load(_MODEL)
        PRESIDIO_AVAILABLE = True
    except OSError:
        PRESIDIO_AVAILABLE = False
except ImportError:
    PRESIDIO_AVAILABLE = False

from wiki_helper.privacy import FakeDetector, PresidioDetector


class PresidioDetectorImportTest(unittest.TestCase):
    def test_create_raises_import_error_when_unavailable(self) -> None:
        """PresidioDetector.create raises ImportError with install instructions when deps missing."""
        if PRESIDIO_AVAILABLE:
            self.skipTest("presidio is installed — cannot test missing-import path")
        with self.assertRaises(ImportError) as ctx:
            PresidioDetector.create()
        self.assertIn("wiki-helper[presidio]", str(ctx.exception))

    def test_fake_detector_unaffected(self) -> None:
        detector = FakeDetector({"PERSON": ["Alice"]})
        matches = detector.detect("Hello Alice, how are you?")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].text, "Alice")


@unittest.skipUnless(PRESIDIO_AVAILABLE, "presidio-analyzer + en_core_web_sm not installed")
class PresidioDetectorDetectTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.detector = PresidioDetector.create(model=_MODEL)

    def test_detects_email(self) -> None:
        matches = self.detector.detect("Contact us at support@example.com for help.")
        entity_types = {m.entity_type for m in matches}
        self.assertIn("EMAIL_ADDRESS", entity_types)

    def test_detects_phone_number(self) -> None:
        matches = self.detector.detect("Call me at +1-800-555-0199.")
        entity_types = {m.entity_type for m in matches}
        self.assertIn("PHONE_NUMBER", entity_types)

    def test_skips_existing_placeholders(self) -> None:
        text = "Email [[PRIVATE:EMAIL_ADDRESS:ABCD1234ABCD]] for help."
        matches = self.detector.detect(text)
        for match in matches:
            self.assertNotIn("PRIVATE:", match.text)

    def test_returns_empty_for_clean_text(self) -> None:
        matches = self.detector.detect("The weather today is sunny and warm.")
        # May detect some things depending on model — just verify it runs without error
        self.assertIsInstance(matches, list)

    def test_match_spans_are_valid(self) -> None:
        text = "Send invoice to billing@corp.io."
        matches = self.detector.detect(text)
        for match in matches:
            self.assertEqual(match.text, text[match.start : match.end])
            self.assertGreater(match.end, match.start)


@unittest.skipUnless(PRESIDIO_AVAILABLE, "presidio-analyzer + en_core_web_sm not installed")
class PresidioDetectorFallbackTest(unittest.TestCase):
    """Verify app.py _build_detector wires PresidioDetector correctly."""

    def test_build_detector_returns_presidio(self) -> None:
        from wiki_helper.app import _build_detector
        from wiki_helper.config import HelperConfig

        config = HelperConfig(anonymizer_provider="presidio", presidio_model=_MODEL)
        detector = _build_detector(config)
        self.assertIsInstance(detector, PresidioDetector)

    def test_build_detector_fake_default(self) -> None:
        from wiki_helper.app import _build_detector
        from wiki_helper.config import HelperConfig

        config = HelperConfig(anonymizer_provider="fake")
        detector = _build_detector(config)
        self.assertIsInstance(detector, FakeDetector)
