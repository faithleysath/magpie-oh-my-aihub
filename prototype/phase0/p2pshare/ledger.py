"""Provider-owned, append-only SQLite journal. All monetary integers are nano-USD.

No blockchain deposit is trusted by this module; a separate watcher must verify
(chain, token contract, recipient, sender, receipt, confirmations) first.
"""
from __future__ import annotations
import hashlib
import hmac
import sqlite3
from contextlib import contextmanager
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

UNITS = Decimal('1000000000')


def dollars_to_nano(value: str | Decimal) -> int:
    x = Decimal(str(value))
    return int((x * UNITS).to_integral_value(rounding=ROUND_HALF_UP))


def cost_nano(tokens: dict, prices: dict) -> int:
    """Calculate seller price; prices are USD per million tokens.

    `input`/`output` exclude cached tokens; cache categories are separately
    charged. Pricing ambiguity must be settled in the Magpie adapter.
    """
    dollars = Decimal(0)
    for key in ('input', 'output', 'cache_read', 'cache_write'):
        t = int(tokens.get(key, 0))
        if t < 0:
            raise ValueError('negative token count')
        dollars += Decimal(t) * Decimal(str(prices.get(key, '0'))) / 1_000_000
    return dollars_to_nano(dollars)


class Ledger:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS buyers (
                  wallet TEXT PRIMARY KEY, caller_key_id TEXT NOT NULL UNIQUE,
                  secret_sha256 TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS journal (
                  seq INTEGER PRIMARY KEY AUTOINCREMENT,
                  wallet TEXT NOT NULL REFERENCES buyers(wallet),
                  kind TEXT NOT NULL CHECK(kind IN ('deposit','usage','refund','adjustment')),
                  ref TEXT NOT NULL UNIQUE, delta_nano INTEGER NOT NULL,
                  meta TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS transactions (
                  chain_id INTEGER NOT NULL, token TEXT NOT NULL,
                  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
                  wallet TEXT NOT NULL REFERENCES buyers(wallet), amount_units INTEGER NOT NULL,
                  PRIMARY KEY(chain_id,token,tx_hash,log_index)
                );
            ''')

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.execute('PRAGMA busy_timeout=10000')
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA journal_mode=WAL')
        try:
            yield db
        finally:
            db.close()

    def register(self, wallet: str, caller_key_id: str, access_key: str):
        if len(access_key) < 24:
            raise ValueError('Use a real Magpie gateway key (>=24 chars)')
        with self._db() as db:
            db.execute('INSERT INTO buyers(wallet,caller_key_id,secret_sha256) VALUES(?,?,?)',
                (wallet.lower(), caller_key_id, hashlib.sha256(access_key.encode()).hexdigest()))

    def authenticate(self, access_key: str) -> str | None:
        digest = hashlib.sha256(access_key.encode()).hexdigest()
        with self._db() as db:
            row = db.execute('SELECT wallet,secret_sha256 FROM buyers WHERE enabled=1 AND secret_sha256=?',
                            (digest,)).fetchone()
        if row and hmac.compare_digest(row[1], digest):
            return row[0]
        return None

    def balance(self, wallet: str) -> int:
        with self._db() as db:
            return db.execute('SELECT COALESCE(SUM(delta_nano),0) FROM journal WHERE wallet=?',
                              (wallet.lower(),)).fetchone()[0]

    def allow(self, wallet: str) -> bool:
        return self.balance(wallet) > 0

    def confirmed_deposit(self, *, wallet: str, chain_id: int, token: str,
                          tx_hash: str, log_index: int, amount_units: int, decimals: int = 6) -> bool:
        """Called ONLY AFTER independent RPC verification. Exactly once.

        This assumes 1 USDC = 1 USD for accounting (no FX); no exchange/issuer
        credit risk modelling. Transaction uniqueness is chain+token+tx+log_index.
        """
        if amount_units <= 0 or not (0 <= decimals <= 18):
            raise ValueError('bad amount/decimals')
        from json import dumps
        wallet, token, tx_hash = wallet.lower(), token.lower(), tx_hash.lower()
        nano = int((Decimal(amount_units) * UNITS / (10 ** decimals)).to_integral_value(rounding=ROUND_HALF_UP))
        ref = f'deposit:{chain_id}:{token}:{tx_hash}:{log_index}'
        with self._db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                db.execute('INSERT INTO transactions VALUES (?,?,?,?,?,?)',
                           (chain_id,token,tx_hash,log_index,wallet,amount_units))
                db.execute('INSERT INTO journal(wallet,kind,ref,delta_nano,meta) VALUES(?,?,?,?,?)',
                           (wallet,'deposit',ref,nano,dumps({'chain':chain_id,'tx':tx_hash,'log':log_index})))
                db.execute('COMMIT')
                return True
            except sqlite3.IntegrityError:
                db.execute('ROLLBACK')
                return False

    def charge_usage(self, *, wallet: str, request_id: str, amount_nano: int,
                     token_meta: str = '{}') -> bool:
        """No pre-deduction. Negative balances permitted after completion.
        Returns False for a duplicate request (idempotent).
        """
        if amount_nano < 0 or not request_id:
            raise ValueError('invalid usage charge')
        with self._db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                db.execute('INSERT INTO journal(wallet,kind,ref,delta_nano,meta) VALUES(?,?,?,?,?)',
                           (wallet.lower(), 'usage', 'usage:'+request_id, -amount_nano, token_meta))
                db.execute('COMMIT')
                return True
            except sqlite3.IntegrityError:
                db.execute('ROLLBACK')
                return False

    def journal(self, wallet: str):
        with self._db() as db:
            return db.execute('SELECT seq,kind,ref,delta_nano,meta,created FROM journal WHERE wallet=? ORDER BY seq',
                              (wallet.lower(),)).fetchall()

    def key_for_caller_id(self, caller_id: str) -> str | None:
        with self._db() as db:
            row = db.execute('SELECT wallet FROM buyers WHERE caller_key_id=? AND enabled=1', (caller_id,)).fetchone()
        return row[0] if row else None
