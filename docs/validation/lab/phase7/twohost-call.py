#!/usr/bin/env python3
"""Run on the consumer host. HTTP data goes through its native Remote Magpie."""
import json, sys, urllib.request, urllib.error, datetime, pathlib
root=pathlib.Path('/tmp/phase7-twohost-network')
models=json.loads((root/'consumer-registered.json').read_text())['models']
assert len(models)==1,models
prompt,completion,expected=map(int,sys.argv[1:4])
body={'model':models[0],'messages':[{'role':'user','content':'isolated nonbillable cross-host acceptance'}],'lab_prompt_tokens':prompt,'lab_completion_tokens':completion}
request=urllib.request.Request('http://127.0.0.1:3449/v1/chat/completions',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
try:
 response=urllib.request.urlopen(request,timeout=25)
except urllib.error.HTTPError as e:
 response=e
with response:
 result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'request':body,'status':response.status,'headers':dict(response.headers),'body':json.load(response)}
with (root/'acceptance-calls.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
print(json.dumps(result))
if result['status']!=expected:raise SystemExit('unexpected HTTP status')
