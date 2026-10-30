#!/usr/bin/env python3
"""Register isolated Remote Magpie without putting the Gateway Key in argv."""
from pathlib import Path
import subprocess,json,os,urllib.request
p=Path('/tmp/phase7-twohost-network');os.umask(0o077)
k=p/'gateway-key.txt'
if k.stat().st_mode & 0o077: raise SystemExit('gateway-key.txt must be mode 0600')
key=k.read_text().strip()
if not key: raise SystemExit('empty key')
name='twohost-provider'
# This pinned CLI has no stdin support for provider keys. Let the official CLI
# create its own record with an unusable placeholder, then replace only that
# record's key while the isolated gateway is stopped.
cmd=['docker','exec','phase7-consumer-magpie','/magpie','provider','add','remote-magpie','sk-test-unusable-placeholder','url=http://127.0.0.1:13448','id='+name]
r=subprocess.run(cmd,capture_output=True,text=True,timeout=40)
(p/'consumer-register.log').write_text((r.stdout+r.stderr).replace(key,'[REDACTED]'))
if r.returncode: raise SystemExit('provider add failed; see consumer-register.log')
subprocess.run(['docker','stop','phase7-consumer-magpie'],check=True,capture_output=True)
f=p/'magpie-config/magpie/providers.json';data=json.loads(f.read_text());found=[]
def patch(x):
 if isinstance(x,dict):
  if x.get('id')==name and x.get('preset')=='remote-magpie': x['key']=key;found.append(x)
  else:
   for v in x.values():patch(v)
 elif isinstance(x,list):
  for v in x:patch(v)
patch(data)
if len(found)!=1: raise SystemExit('expected one isolated Remote Magpie record')
tmp=f.with_suffix('.phase7-tmp');tmp.write_text(json.dumps(data,indent=2)+'\n');os.chown(tmp,65532,65532);tmp.chmod(0o600);tmp.replace(f)
subprocess.run(['docker','start','phase7-consumer-magpie'],check=True,capture_output=True)
r=subprocess.run(['docker','exec','phase7-consumer-magpie','/magpie','provider','refresh',name],capture_output=True,text=True,timeout=40)
with (p/'consumer-register.log').open('a') as out:out.write((r.stdout+r.stderr).replace(key,'[REDACTED]'))
if r.returncode:raise SystemExit('refresh failed; see consumer-register.log')
with urllib.request.urlopen('http://127.0.0.1:3449/v1/models',timeout=20) as response:data=json.load(response)
(p/'consumer-models.json').write_text(json.dumps(data,indent=2)+'\n')
models=[x['id'] for x in data.get('data',[]) if x.get('id','').startswith(name+'/')]
result={'registered':True,'provider_id':name,'models':models}
(p/'consumer-registered.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
