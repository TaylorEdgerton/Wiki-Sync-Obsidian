import unittest

from wiki_helper.privacy import (
    CompositeDetector,
    FakeDetector,
    InMemoryEntityMap,
    InMemoryPrivacyPolicy,
    LocalXorCipher,
    PLACEHOLDER_RE,
    reveal_text,
    sanitize_text,
)


class PrivacyTests(unittest.TestCase):
    def test_same_value_reuses_placeholder(self):
        entity_map = InMemoryEntityMap()
        detector = FakeDetector({"person": ["Taylor"]})
        cipher = LocalXorCipher("test-key")

        first = sanitize_text("Taylor owns this note.", detector, entity_map, cipher)
        second = sanitize_text("Ask Taylor.", detector, entity_map, cipher)

        first_placeholder = PLACEHOLDER_RE.search(first.text).group(0)
        second_placeholder = PLACEHOLDER_RE.search(second.text).group(0)
        self.assertEqual(first_placeholder, second_placeholder)

    def test_different_entity_types_do_not_collide(self):
        entity_map = InMemoryEntityMap()
        cipher = LocalXorCipher("test-key")

        person = entity_map.upsert("person", "Acme", cipher)
        company = entity_map.upsert("company", "Acme", cipher)

        self.assertNotEqual(person.placeholder, company.placeholder)

    def test_sanitization_is_idempotent_over_placeholders(self):
        entity_map = InMemoryEntityMap()
        detector = FakeDetector({"person": ["Taylor"]})
        cipher = LocalXorCipher("test-key")

        first = sanitize_text("Taylor", detector, entity_map, cipher)
        second = sanitize_text(first.text, detector, entity_map, cipher)

        self.assertEqual(first.text, second.text)
        self.assertEqual(second.entities, ())

    def test_reveal_leaves_unknown_placeholder_unresolved(self):
        result = reveal_text("[[PRIVATE:PERSON:ABCDEF123456]]", InMemoryEntityMap(), LocalXorCipher("test-key"))

        self.assertEqual(result.text, "[[PRIVATE:PERSON:ABCDEF123456]]")
        self.assertEqual(result.unresolved_placeholders, ("[[PRIVATE:PERSON:ABCDEF123456]]",))

    def test_reveal_resolves_known_placeholder(self):
        entity_map = InMemoryEntityMap()
        detector = FakeDetector({"host": ["db01.internal"]})
        cipher = LocalXorCipher("test-key")

        sanitized = sanitize_text("Host db01.internal restarted.", detector, entity_map, cipher)
        revealed = reveal_text(sanitized.text, entity_map, cipher)

        self.assertEqual(revealed.text, "Host db01.internal restarted.")
        self.assertEqual(revealed.unresolved_placeholders, ())

    def test_policy_terms_drive_sanitization(self):
        policy = InMemoryPrivacyPolicy()
        policy.add_private_term("system", "LogSafe")
        detector = FakeDetector({
            term.entity_type: [term.term]
            for term in policy.private_terms()
        })
        entity_map = InMemoryEntityMap()

        sanitized = sanitize_text("Open LogSafe.", detector, entity_map, LocalXorCipher("test-key"))

        self.assertIn("[[PRIVATE:SYSTEM:", sanitized.text)

    def test_allowlist_suppresses_matches(self):
        entity_map = InMemoryEntityMap()
        detector = FakeDetector({"person": ["Taylor"]})

        sanitized = sanitize_text(
            "Taylor should stay public.",
            detector,
            entity_map,
            LocalXorCipher("test-key"),
            allowlist_terms=("Taylor",),
        )

        self.assertEqual(sanitized.text, "Taylor should stay public.")
        self.assertEqual(sanitized.entities, ())

    def test_composite_detector_combines_matches(self):
        detector = CompositeDetector((
            FakeDetector({"person": ["Taylor"]}),
            FakeDetector({"host": ["db01"]}),
        ))

        matches = detector.detect("Taylor owns db01.")

        self.assertEqual({match.entity_type for match in matches}, {"PERSON", "HOST"})


if __name__ == "__main__":
    unittest.main()
