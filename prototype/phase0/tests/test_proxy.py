from fastapi.testclient import TestClient
from p2pshare import server
from p2pshare.ledger import Ledger

WALLET='0x2222222222222222222222222222222222222222'
KEY='sk-magpie-key-test-buyer-22222222222222222'


def test_manifest_auth_and_credit_admission(tmp_path, monkeypatch):
    ledger=Ledger(tmp_path/'test.sqlite')
    ledger.register(WALLET, 'caller-2', KEY)
    monkeypatch.setattr(server,'ledger',ledger)
    monkeypatch.setattr(server,'WALLET','0xProvider')
    monkeypatch.setattr(server,'OFFERS',{'provider/model':{'input':'1','output':'5'}})
    client=TestClient(server.app)
    manifest=client.get('/p2p/manifest')
    assert manifest.status_code==200
    assert manifest.json()['wallet']=='0xProvider'
    assert 'gateway_key' not in manifest.text
    assert client.get('/v1/models').status_code==401
    assert client.get('/v1/magpie/usage/requests',headers={'authorization':f'Bearer {KEY}'}).status_code==404
    assert client.post('/v1/chat/completions',json={'model':'provider/model','messages':[]},
                       headers={'authorization':f'Bearer {KEY}'}).status_code==402
    ledger.confirmed_deposit(wallet=WALLET,chain_id=8453,token='DEV',tx_hash='0x1',log_index=0,amount_units=10_000)
    assert ledger.allow(WALLET)
    assert client.post('/v1/chat/completions',json={'model':'unlisted','messages':[]},
                       headers={'authorization':f'Bearer {KEY}'}).status_code==403


def test_streaming_forward_with_mock_magpie(tmp_path, monkeypatch):
    import httpx
    ledger=Ledger(tmp_path/'stream.sqlite')
    ledger.register(WALLET,'caller-2',KEY)
    ledger.confirmed_deposit(wallet=WALLET,chain_id=8453,token='DEV',tx_hash='0x2',log_index=0,amount_units=1_000_000)
    monkeypatch.setattr(server,'ledger',ledger)
    monkeypatch.setattr(server,'OFFERS',{'provider/model':{'input':'1','output':'5'}})
    def upstream(req):
        assert req.headers['authorization']==f'Bearer {KEY}'
        assert req.url.path=='/v1/chat/completions'
        return httpx.Response(200,headers={'content-type':'text/event-stream'},
                              stream=httpx.ByteStream(b'data: {"delta":"ok"}\n\ndata: [DONE]\n\n'))
    original_async=httpx.AsyncClient
    def make_client(**kwargs):
        return original_async(transport=httpx.MockTransport(upstream),**kwargs)
    monkeypatch.setattr(server.httpx,'AsyncClient',make_client)
    client=TestClient(server.app)
    res=client.post('/v1/chat/completions',json={'model':'provider/model','stream':True,'messages':[]},
                    headers={'authorization':f'Bearer {KEY}'})
    assert res.status_code==200
    assert res.headers['content-type'].startswith('text/event-stream')
    assert 'data: [DONE]' in res.text
