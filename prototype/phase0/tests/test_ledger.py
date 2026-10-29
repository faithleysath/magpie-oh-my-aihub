from concurrent.futures import ThreadPoolExecutor
from p2pshare.ledger import Ledger, dollars_to_nano, cost_nano

WALLET='0x1111111111111111111111111111111111111111'
KEY='sk-magpie-key-for-developer-testing-0000000000'

def test_ledger_negative_balance_and_retry(tmp_path):
    ledger=Ledger(tmp_path/'test.db')
    ledger.register(WALLET,'caller-1',KEY)
    assert ledger.authenticate(KEY)==WALLET
    assert ledger.authenticate('wrong') is None
    assert not ledger.allow(WALLET)
    assert ledger.confirmed_deposit(wallet=WALLET,chain_id=8453,token='0xUSDC',tx_hash='0x123',log_index=3,amount_units=20_000)
    assert not ledger.confirmed_deposit(wallet=WALLET,chain_id=8453,token='0xUSDC',tx_hash='0x123',log_index=3,amount_units=20_000)
    assert ledger.balance(WALLET)==dollars_to_nano('0.02')
    assert ledger.allow(WALLET)
    assert ledger.charge_usage(wallet=WALLET,request_id='id-1',amount_nano=dollars_to_nano('0.05'))
    assert not ledger.charge_usage(wallet=WALLET,request_id='id-1',amount_nano=dollars_to_nano('0.05'))
    assert ledger.balance(WALLET)==dollars_to_nano('-0.03')
    assert not ledger.allow(WALLET)
    assert ledger.confirmed_deposit(wallet=WALLET,chain_id=8453,token='0xUSDC',tx_hash='0x124',log_index=0,amount_units=100_000)
    assert ledger.balance(WALLET)==dollars_to_nano('0.07')
    assert ledger.allow(WALLET)

def test_concurrent_idempotency(tmp_path):
    ledger=Ledger(tmp_path/'concurrent.db');ledger.register(WALLET,'caller-1',KEY)
    ledger.confirmed_deposit(wallet=WALLET,chain_id=8453,token='0xUSDC',tx_hash='0x1',log_index=0,amount_units=1000000)
    with ThreadPoolExecutor(max_workers=8) as pool:
        successes=list(pool.map(lambda _:ledger.charge_usage(wallet=WALLET,request_id='same',amount_nano=1000),range(40)))
    assert sum(successes)==1
    assert ledger.balance(WALLET)==dollars_to_nano('1')-1000

def test_price():
    assert cost_nano({'input':1000,'output':200,'cache_read':0,'cache_write':0},
                     {'input':'1','output':'5'})==dollars_to_nano('0.002')
