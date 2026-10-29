"""Thin HTTP streaming gateway in front of Magpie; never forwards management API.

This slice is NOT an overlay transport: run behind EasyTier's no-TUN overlay.
Host firewalls must block direct LAN/WAN access to its service port.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from .ledger import Ledger

BASE = os.environ.get('MAGPIE_BASE', 'http://127.0.0.1:3425').rstrip('/')
DB = os.environ.get('P2P_DB', str(Path.home() / '.magpie-p2p' / 'ledger.sqlite'))
OFFERS = json.loads(os.environ.get('P2P_OFFERS', '{}'))
WALLET = os.environ.get('P2P_WALLET', '')
ledger = Ledger(DB)
app = FastAPI(title='Magpie P2P share proxy', docs_url=None, redoc_url=None, openapi_url=None)

# An explicit allowlist avoids accidentally sharing Magpie's admin, usage,
# trace, sessions or plugin APIs. Other protocols need reviewed additions.
GETS = {'/v1/models', '/v1/magpie/limit'}
POSTS = {'/v1/chat/completions','/v1/responses','/v1/messages'}
SAFE_RESPONSE_HEADERS = {'content-type', 'cache-control', 'x-magpie-provider',
                         'x-magpie-model', 'x-request-id'}

@app.get('/p2p/manifest')
async def manifest():
    return {'protocol':'magpie-p2p/0.1', 'wallet':WALLET, 'offers':OFFERS}


async def forward(req: Request, path: str):
    if (req.method == 'GET' and path not in GETS) or (req.method == 'POST' and path not in POSTS):
        raise HTTPException(404, 'Not shared')
    if req.method not in ('GET','POST'):
        raise HTTPException(405, 'Not supported')
    key = req.headers.get('authorization','').removeprefix('Bearer ').strip()
    wallet = ledger.authenticate(key) if key else None
    if wallet is None:
        raise HTTPException(401, 'Unknown gateway key')
    if req.method == 'POST' and not ledger.allow(wallet):
        raise HTTPException(402, 'Prepaid balance <= 0')
    raw = await req.body()
    if len(raw) > 4 * 1024 * 1024:
        raise HTTPException(413, 'Request too large in this development slice')
    if req.method == 'POST':
        try:
            model = json.loads(raw).get('model')
        except (ValueError, AttributeError):
            raise HTTPException(400, 'JSON request required')
        if model not in OFFERS:
            raise HTTPException(403, 'Model not published')
    url = BASE + path
    if req.url.query:
        # Deliberately disallow URL-based bearer credentials and arbitrary query APIs.
        raise HTTPException(400, 'Query parameters not supported in this development slice')
    client = httpx.AsyncClient(timeout=httpx.Timeout(15, read=None), trust_env=False)
    outgoing = {'Authorization':f'Bearer {key}', 'Accept':req.headers.get('accept','*/*')}
    if req.method == 'POST':
        outgoing['Content-Type'] = 'application/json'
    try:
        upstream = await client.send(client.build_request(req.method,url,content=raw,headers=outgoing), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(502, 'Local Magpie not reachable')
    headers = {k:v for k,v in upstream.headers.items() if k.lower() in SAFE_RESPONSE_HEADERS}
    async def stream():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
    return StreamingResponse(stream(), status_code=upstream.status_code, headers=headers)


@app.api_route('/v1/{tail:path}', methods=['GET','POST'])
async def v1(req:Request, tail:str):
    return await forward(req, '/v1/'+tail)
