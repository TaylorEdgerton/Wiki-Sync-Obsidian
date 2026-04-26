# Wiki Helper

Local sidecar for Wiki Sync privacy and retrieval work.

Current status: skeleton only. The health endpoint and route stubs exist, but plugin sync paths do not call this helper yet.

## Run

```bash
cd wiki-helper
PYTHONPATH=src python -m wiki_helper.app
```

Default endpoint:

```text
http://127.0.0.1:8765/health
```

## Environment

- `WIKI_HELPER_HOST`: bind host, default `127.0.0.1`
- `WIKI_HELPER_PORT`: bind port, default `8765`
- `WIKI_HELPER_DATABASE_URL`: optional Postgres connection string
- `WIKI_HELPER_EMBEDDING_PROVIDER`: default `fake`
- `WIKI_HELPER_EMBEDDING_DIMENSION`: default `1536`

## Test

```bash
cd wiki-helper
PYTHONPATH=src python -m unittest discover -s tests
```

