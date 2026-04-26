import unittest

from wiki_helper.config import load_config


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        config = load_config({})
        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.port, 8765)
        self.assertEqual(config.embedding_provider, "fake")
        self.assertEqual(config.embedding_dimension, 1536)

    def test_invalid_numbers_fall_back(self):
        config = load_config({
            "WIKI_HELPER_PORT": "not-a-port",
            "WIKI_HELPER_EMBEDDING_DIMENSION": "-1",
        })
        self.assertEqual(config.port, 8765)
        self.assertEqual(config.embedding_dimension, 1536)


if __name__ == "__main__":
    unittest.main()

