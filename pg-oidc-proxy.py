"""
pg-oidc-proxy: A lightweight TCP proxy that gates Postgres connections behind OIDC JWT validation.

Client sends a JWT (from Entra, Authentik, Keycloak, etc.) as the Postgres password.
Proxy validates it against the provider's JWKS, checks optional group claims,
then pipes through to the real Postgres backend using a service account.

Works with Wiki Sync: use a password flow that returns a fresh JWT.
"""

import asyncio
import struct
import json
import time
import os
import ssl
import logging
from dataclasses import dataclass
from typing import Optional

import json as _json
import ssl as _ssl
import urllib.request as _urllib_req
import jwt as pyjwt  # PyJWT
from jwt import PyJWKClient

# Dev-only: skip TLS verification globally so PyJWKClient works with self-signed certs
_ssl._create_default_https_context = _ssl._create_unverified_context

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("pg-oidc-proxy")


# ── Config ──────────────────────────────────────────────────────────────────

@dataclass
class Config:
    listen_addr: str        # e.g. "0.0.0.0"
    listen_port: int        # e.g. 5432
    backend_addr: str       # real postgres host
    backend_port: int       # real postgres port (e.g. 5433)
    backend_user: str       # service account for backend auth
    backend_pass: str       # service account password
    oidc_issuer: str        # e.g. "https://login.microsoftonline.com/{tenant}/v2.0"
                            #   or "https://idp.yourco.com/application/o/pg-proxy/"
    oidc_audience: str      # your app registration client ID
    oidc_clock_skew_seconds: int  # acceptable clock skew when validating iat/nbf
    oidc_group_claim: str   # claim name containing groups (e.g. "groups")
    allowed_group: str      # required group ID/name, empty = skip check
    tls_cert: str           # path to TLS cert (optional, recommended for production)
    tls_key: str            # path to TLS key
    backend_db: str         # default database to use if client doesn't specify

    @classmethod
    def from_env(cls):
        return cls(
            listen_addr=os.getenv("LISTEN_ADDR", "0.0.0.0"),
            listen_port=int(os.getenv("LISTEN_PORT", "5432")),
            backend_addr=os.getenv("BACKEND_ADDR", "localhost"),
            backend_port=int(os.getenv("BACKEND_PORT", "5433")),
            backend_user=os.getenv("BACKEND_USER", "postgres"),
            backend_pass=os.getenv("BACKEND_PASS", ""),
            oidc_issuer=os.getenv("OIDC_ISSUER", ""),
            oidc_audience=os.getenv("OIDC_AUDIENCE", ""),
            oidc_clock_skew_seconds=int(os.getenv("OIDC_CLOCK_SKEW_SECONDS", "300")),
            oidc_group_claim=os.getenv("OIDC_GROUP_CLAIM", "groups"),
            allowed_group=os.getenv("OIDC_ALLOWED_GROUP", ""),
            tls_cert=os.getenv("TLS_CERT_FILE", ""),
            tls_key=os.getenv("TLS_KEY_FILE", ""),
            backend_db=os.getenv("BACKEND_DB", ""),
        )


# ── JWKS Cache ──────────────────────────────────────────────────────────────
# PyJWT's built-in JWK client handles fetching + caching keys from the
# provider's JWKS endpoint. We just need to discover it from the issuer.

class TokenValidator:
    def __init__(self, cfg: Config):
        self.issuer = cfg.oidc_issuer  # keep as-is; must match JWT iss claim exactly
        self.audience = cfg.oidc_audience
        self.clock_skew_seconds = cfg.oidc_clock_skew_seconds
        self.group_claim = cfg.oidc_group_claim
        self.allowed_group = cfg.allowed_group
        self._jwk_client: Optional[PyJWKClient] = None

    @staticmethod
    def _format_timestamp(value) -> str:
        try:
            ts = int(value)
        except (TypeError, ValueError):
            return str(value)
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))

    def _timing_debug(self, token_str: str) -> str:
        try:
            claims = pyjwt.decode(
                token_str,
                options={
                    "verify_signature": False,
                    "verify_exp": False,
                    "verify_iat": False,
                    "verify_nbf": False,
                    "verify_aud": False,
                    "verify_iss": False,
                },
            )
        except Exception:
            return ""

        now = int(time.time())
        details = [f"now={self._format_timestamp(now)}"]
        for claim_name in ("iat", "nbf", "exp"):
            claim_value = claims.get(claim_name)
            if not isinstance(claim_value, (int, float)):
                continue
            details.append(
                f"{claim_name}={self._format_timestamp(claim_value)} ({int(claim_value) - now:+d}s vs local)"
            )
        details.append(f"leeway={self.clock_skew_seconds}s")
        return "; ".join(details)

    async def _ensure_jwks(self):
        """Discover JWKS URI from OIDC well-known endpoint, lazily."""
        if self._jwk_client:
            return
        url = f"{self.issuer.rstrip('/')}/.well-known/openid-configuration"
        # Skip TLS verification for self-signed certs (dev); remove in prod
        _ssl_ctx = _ssl.create_default_context()
        _ssl_ctx.check_hostname = False
        _ssl_ctx.verify_mode = _ssl.CERT_NONE
        req = _urllib_req.Request(url)
        with _urllib_req.urlopen(req, context=_ssl_ctx) as r:
            jwks_uri = _json.loads(r.read())["jwks_uri"]
        # PyJWT's PyJWKClient also needs to skip TLS for self-signed certs
        self._jwk_client = PyJWKClient(jwks_uri, cache_keys=True, lifespan=3600)
        log.info(f"JWKS endpoint: {jwks_uri}")

    async def validate(self, token_str: str) -> dict:
        """Validate JWT, return claims dict. Raises on any failure."""
        await self._ensure_jwks()

        # PyJWKClient.get_signing_key_from_jwt fetches the right key by 'kid'
        signing_key = self._jwk_client.get_signing_key_from_jwt(token_str)

        try:
            claims = pyjwt.decode(
                token_str,
                signing_key.key,
                algorithms=["RS256", "ES256"],
                issuer=self.issuer,
                audience=self.audience,
                options={"require": ["exp", "iss", "aud"]},
                leeway=self.clock_skew_seconds,
            )
        except pyjwt.ImmatureSignatureError as exc:
            timing = self._timing_debug(token_str)
            message = "The token is not yet valid. Local clock may be behind the issuer."
            if timing:
                message = f"{message} {timing}"
            raise PermissionError(message) from exc

        # Optional group check
        if self.allowed_group:
            groups = claims.get(self.group_claim, [])
            if self.allowed_group not in groups:
                raise PermissionError(
                    f"User not in required group '{self.allowed_group}'. "
                    f"Groups in token: {groups}"
                )

        return claims


# ── Postgres Wire Protocol (minimal) ────────────────────────────────────────
# We only parse enough to intercept the startup handshake and auth exchange.
# After auth succeeds, we blind-pipe all bytes.
#
# Reference: https://www.postgresql.org/docs/current/protocol-message-formats.html

def parse_startup_message(data: bytes) -> dict:
    """
    StartupMessage: Int32 len | Int32 protocol(196608=3.0) | key\0value\0...key\0value\0 \0
    Returns dict like {"user": "alice", "database": "mydb", ...}
    """
    length = struct.unpack("!I", data[:4])[0]
    protocol = struct.unpack("!I", data[4:8])[0]

    if protocol == 80877103:  # SSLRequest
        return {"__ssl_request": True}

    if protocol != 196608:  # 3.0
        raise ValueError(f"Unsupported protocol version: {protocol}")

    params = {}
    body = data[8:length]
    parts = body.split(b"\x00")
    i = 0
    while i < len(parts) - 1 and parts[i]:
        key = parts[i].decode("utf-8")
        val = parts[i + 1].decode("utf-8") if i + 1 < len(parts) else ""
        params[key] = val
        i += 2
    return params


def make_auth_cleartext_request() -> bytes:
    """Server -> Client: please send password in cleartext."""
    # 'R' | Int32(8) | Int32(3) = AuthenticationCleartextPassword
    return b"R" + struct.pack("!II", 8, 3)


def make_auth_ok() -> bytes:
    """Server -> Client: authentication successful."""
    return b"R" + struct.pack("!II", 8, 0)


def make_error(severity: str, code: str, message: str) -> bytes:
    """Server -> Client: error response."""
    # ErrorResponse: 'E' | Int32 len | fields...
    body = b""
    body += b"S" + severity.encode() + b"\x00"
    body += b"C" + code.encode() + b"\x00"
    body += b"M" + message.encode() + b"\x00"
    body += b"\x00"  # terminator
    return b"E" + struct.pack("!I", len(body) + 4) + body


def make_startup_message(user: str, database: str) -> bytes:
    """Build a StartupMessage to send to the real backend."""
    params = f"user\x00{user}\x00database\x00{database}\x00\x00".encode()
    length = 4 + 4 + len(params)  # len + protocol + params
    return struct.pack("!II", length, 196608) + params


def make_password_message(password: str) -> bytes:
    """Client -> Server: password response."""
    pwd = password.encode() + b"\x00"
    return b"p" + struct.pack("!I", len(pwd) + 4) + pwd


async def read_startup(reader: asyncio.StreamReader) -> bytes:
    """Read a startup message (length-prefixed, no type byte)."""
    raw_len = await reader.readexactly(4)
    length = struct.unpack("!I", raw_len)[0]
    rest = await reader.readexactly(length - 4)
    return raw_len + rest


async def read_message(reader: asyncio.StreamReader) -> tuple[bytes, bytes]:
    """Read a typed PG message: type(1) + len(4) + body. Returns (type, full_message)."""
    msg_type = await reader.readexactly(1)
    raw_len = await reader.readexactly(4)
    length = struct.unpack("!I", raw_len)[0]
    body = await reader.readexactly(length - 4)
    return msg_type, msg_type + raw_len + body


# ── The Proxy ────────────────────────────────────────────────────────────────

async def pipe(label: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """Blind-copy bytes in one direction until EOF."""
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle_client(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    cfg: Config,
    validator: TokenValidator,
):
    peer = client_writer.get_extra_info("peername")
    log.info(f"[{peer}] new connection")

    try:
        # ── Step 1: Read client StartupMessage ──
        raw_startup = await asyncio.wait_for(read_startup(client_reader), timeout=30)
        params = parse_startup_message(raw_startup)

        # Handle SSL negotiation (decline for now, client retries without)
        if params.get("__ssl_request"):
            if cfg.tls_cert:
                # Accept SSL: send 'S', then upgrade connection
                client_writer.write(b"S")
                await client_writer.drain()
                ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ssl_ctx.load_cert_chain(cfg.tls_cert, cfg.tls_key)
                transport = client_writer.transport
                protocol = transport.get_protocol()
                new_transport = await asyncio.get_event_loop().start_tls(
                    transport, protocol, ssl_ctx, server_side=True
                )
                client_reader._transport = new_transport
                client_writer._transport = new_transport
            else:
                # Decline SSL: send 'N', client will retry in plaintext
                client_writer.write(b"N")
                await client_writer.drain()

            # Re-read the actual startup message
            raw_startup = await asyncio.wait_for(read_startup(client_reader), timeout=30)
            params = parse_startup_message(raw_startup)

        client_user = params.get("user", "unknown")
        client_db = params.get("database", cfg.backend_db)
        log.info(f"[{peer}] startup: user={client_user} database={client_db}")

        # ── Step 2: Ask client for password (the JWT) ──
        client_writer.write(make_auth_cleartext_request())
        await client_writer.drain()

        msg_type, msg_data = await asyncio.wait_for(read_message(client_reader), timeout=60)
        if msg_type != b"p":
            raise ValueError(f"Expected PasswordMessage, got {msg_type!r}")

        # Password is null-terminated string after type(1) + len(4)
        token_str = msg_data[5:].rstrip(b"\x00").decode("utf-8")

        # ── Step 3: Validate the JWT ──
        try:
            claims = await validator.validate(token_str)
        except Exception as e:
            log.warning(f"[{peer}] auth failed for {client_user}: {e}")
            client_writer.write(make_error("FATAL", "28P01", f"OIDC auth failed: {e}"))
            await client_writer.drain()
            return

        identity = claims.get("preferred_username") or claims.get("sub", "unknown")
        log.info(f"[{peer}] authenticated: {identity} (pg_user={client_user})")

        # ── Step 4: Connect to real Postgres backend ──
        backend_reader, backend_writer = await asyncio.open_connection(
            cfg.backend_addr, cfg.backend_port
        )

        # Send startup to backend with service account
        backend_writer.write(make_startup_message(cfg.backend_user, client_db))
        await backend_writer.drain()

        # Handle backend auth (cleartext, md5, scram-sha-256)
        auth_type, auth_msg = await read_message(backend_reader)
        if auth_type == b"R":
            auth_code = struct.unpack("!I", auth_msg[5:9])[0]

            if auth_code == 3:  # CleartextPassword
                backend_writer.write(make_password_message(cfg.backend_pass))
                await backend_writer.drain()

            elif auth_code == 5:  # MD5
                import hashlib
                salt = auth_msg[9:13]
                inner = hashlib.md5(
                    cfg.backend_pass.encode() + cfg.backend_user.encode()
                ).hexdigest().encode()
                outer = b"md5" + hashlib.md5(inner + salt).hexdigest().encode()
                backend_writer.write(make_password_message(outer.decode()))
                await backend_writer.drain()

            elif auth_code == 10:  # SCRAM-SHA-256
                import hashlib, hmac, base64, secrets as _sec
                # Client-first
                cnonce = base64.b64encode(_sec.token_bytes(18)).decode()
                cfbare = f"n={cfg.backend_user},r={cnonce}"
                cf = f"n,,{cfbare}".encode()
                mech = b"SCRAM-SHA-256\x00"
                body = mech + struct.pack("!i", len(cf)) + cf
                backend_writer.write(b"p" + struct.pack("!I", len(body) + 4) + body)
                await backend_writer.drain()
                # Server-first (type 11)
                _, sm = await read_message(backend_reader)
                sf = sm[9:].decode()
                p = dict(x.split("=", 1) for x in sf.split(",") if "=" in x)
                snonce, salt2, iters = p["r"], base64.b64decode(p["s"]), int(p["i"])
                assert snonce.startswith(cnonce)
                # SCRAM math
                spwd = hashlib.pbkdf2_hmac("sha256", cfg.backend_pass.encode(), salt2, iters)
                ck = hmac.new(spwd, b"Client Key", hashlib.sha256).digest()
                sk = hashlib.sha256(ck).digest()
                cfwp = f"c=biws,r={snonce}"
                am = f"{cfbare},{sf},{cfwp}"
                csig = hmac.new(sk, am.encode(), hashlib.sha256).digest()
                proof = base64.b64encode(bytes(a ^ b for a, b in zip(ck, csig))).decode()
                final = f"{cfwp},p={proof}".encode()
                backend_writer.write(b"p" + struct.pack("!I", len(final) + 4) + final)
                await backend_writer.drain()
                # Server-final (type 12) — consume it
                _, sf_msg = await read_message(backend_reader)
                if struct.unpack("!I", sf_msg[5:9])[0] != 12:
                    raise ConnectionError("Expected SCRAM server-final")

            elif auth_code == 0:  # AuthOk (trust)
                pass

            else:
                raise ValueError(f"Unsupported backend auth type: {auth_code}")

            # Read until we get AuthOk from backend
            if auth_code != 0:
                at, am = await read_message(backend_reader)
                if at == b"E":
                    raise ConnectionError("Backend auth failed")

        # ── Step 5: Tell client auth is OK ──
        client_writer.write(make_auth_ok())
        await client_writer.drain()

        # Forward any post-auth backend messages (ParameterStatus, BackendKeyData, ReadyForQuery)
        # We need to relay these to the client so it knows the connection is ready
        while True:
            msg_t, msg_d = await read_message(backend_reader)
            client_writer.write(msg_d)
            await client_writer.drain()
            if msg_t == b"Z":  # ReadyForQuery
                break
            if msg_t == b"E":  # Error
                log.error(f"[{peer}] backend error during setup")
                return

        log.info(f"[{peer}] proxying: {identity} -> {cfg.backend_addr}:{cfg.backend_port}/{client_db}")

        # ── Step 6: Blind pipe in both directions ──
        await asyncio.gather(
            pipe("client->backend", client_reader, backend_writer),
            pipe("backend->client", backend_reader, client_writer),
        )

    except asyncio.TimeoutError:
        log.warning(f"[{peer}] timeout during handshake")
        client_writer.write(make_error("FATAL", "08000", "Handshake timeout"))
        await client_writer.drain()
    except Exception as e:
        log.error(f"[{peer}] error: {e}")
        try:
            client_writer.write(make_error("FATAL", "08000", str(e)))
            await client_writer.drain()
        except Exception:
            pass
    finally:
        try:
            client_writer.close()
        except Exception:
            pass
        log.info(f"[{peer}] disconnected")


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    cfg = Config.from_env()
    validator = TokenValidator(cfg)

    # Pre-warm JWKS cache
    try:
        await validator._ensure_jwks()
    except Exception as e:
        log.error(f"Failed to fetch JWKS on startup: {e}")
        log.error("Check OIDC_ISSUER is correct and reachable")
        return

    server = await asyncio.start_server(
        lambda r, w: handle_client(r, w, cfg, validator),
        cfg.listen_addr,
        cfg.listen_port,
    )

    addr = server.sockets[0].getsockname()
    log.info(f"pg-oidc-proxy listening on {addr[0]}:{addr[1]}")
    log.info(f"Backend: {cfg.backend_addr}:{cfg.backend_port}")
    log.info(f"OIDC issuer: {cfg.oidc_issuer}")
    log.info(f"OIDC clock skew leeway: {cfg.oidc_clock_skew_seconds}s")
    log.info(f"Group check: {cfg.allowed_group or '(disabled)'}")

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
