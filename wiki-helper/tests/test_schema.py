import unittest

from wiki_helper.db import read_bootstrap_schema, split_sql_statements


class SchemaTests(unittest.TestCase):
    def test_schema_contains_expected_tables(self):
        sql = read_bootstrap_schema()
        self.assertIn("wiki_private.entity_map", sql)
        self.assertIn("wiki_public.sanitized_documents", sql)
        self.assertIn("wiki_public.chunks", sql)

    def test_schema_splits_into_statements(self):
        statements = split_sql_statements(read_bootstrap_schema())
        self.assertGreaterEqual(len(statements), 5)


if __name__ == "__main__":
    unittest.main()

