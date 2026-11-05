"""Isolated local PostgreSQL for portal tests; never starts another project."""
import json, os, pathlib, socket, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
LOCAL=ROOT/'.local'/'platform-test'
DATA=LOCAL/'postgres'
PG=pathlib.Path(os.getenv('PG_BIN','C:/Program Files/PostgreSQL/18/bin'))
PORT=18983
FLAGS=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
LOCAL.mkdir(parents=True,exist_ok=True)
def command(name,*args):
    with (LOCAL/'control.log').open('ab') as log:
        result=subprocess.run([str(PG/(name+'.exe')),*map(str,args)],stdout=log,stderr=log,creationflags=FLAGS,timeout=60)
    if result.returncode:
        raise SystemExit('Database command failed; see .local/platform-test/control.log')
if len(sys.argv)>1 and sys.argv[1]=='stop':
    if (DATA/'postmaster.pid').exists():command('pg_ctl','-D',DATA,'-m','fast','-w','stop')
    print('Isolated portal test PostgreSQL stopped.');raise SystemExit
if not (DATA/'PG_VERSION').exists():
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1',PORT))==0:raise SystemExit('Dedicated test port is occupied; refusing to reuse it')
    command('initdb','-D',DATA,'-U','gptreg_test','--auth=trust','--encoding=UTF8','--locale=C')
    with (DATA/'postgresql.conf').open('a',encoding='utf-8') as f:f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nmax_connections=40\n")
if not (DATA/'postmaster.pid').exists():command('pg_ctl','-D',DATA,'-l',LOCAL/'postgres.log','-w','start')
url=f'postgresql://gptreg_test@127.0.0.1:{PORT}/postgres'
(LOCAL/'connection.json').write_text(json.dumps({'url':url}),encoding='utf-8')
print('Isolated portal test PostgreSQL ready on 18983.')
