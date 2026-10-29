"""Local-only CLI; do not expose any of these operations as HTTP methods."""
import argparse
import json
import os
from .ledger import Ledger, dollars_to_nano, cost_nano


def main():
    p=argparse.ArgumentParser(description='Provider-side P2P ledger operator')
    p.add_argument('--db', default=os.environ.get('P2P_DB',os.path.expanduser('~/.magpie-p2p/ledger.sqlite')))
    commands=p.add_subparsers(dest='cmd',required=True)
    r=commands.add_parser('register')
    r.add_argument('wallet');r.add_argument('caller_key_id');r.add_argument('gateway_key')
    b=commands.add_parser('balance');b.add_argument('wallet')
    j=commands.add_parser('journal');j.add_argument('wallet')
    d=commands.add_parser('dev-credit', help='LOCAL TEST ONLY: simulates independently verified blockchain deposit')
    d.add_argument('wallet');d.add_argument('txhash');d.add_argument('usd')
    c=commands.add_parser('charge', help='TEST ONLY: real bills must come from verified Magpie usage rows')
    c.add_argument('wallet');c.add_argument('rid');c.add_argument('usd')
    i=commands.add_parser('import-normalized',help='Imports trusted normalized Magpie request rows from a local JSON file')
    i.add_argument('path');i.add_argument('price_config')
    args=p.parse_args();ledger=Ledger(args.db)
    if args.cmd=='register':
        ledger.register(args.wallet,args.caller_key_id,args.gateway_key)
        print('registered')
    elif args.cmd=='balance':
        print(json.dumps({'wallet':args.wallet,'balance_USD':str(ledger.balance(args.wallet)/1e9),'admit':ledger.allow(args.wallet)}))
    elif args.cmd=='journal':
        print(json.dumps(ledger.journal(args.wallet)))
    elif args.cmd=='dev-credit':
        units=int((__import__('decimal').Decimal(args.usd)*1_000_000).to_integral_value())
        print('DEV-ONLY credit:',ledger.confirmed_deposit(wallet=args.wallet,chain_id=8453,token='DEV-USDC',tx_hash=args.txhash,
                                                          log_index=0,amount_units=units))
    elif args.cmd=='charge':
        print('TEST ONLY:',ledger.charge_usage(wallet=args.wallet,request_id=args.rid,amount_nano=dollars_to_nano(args.usd)))
    elif args.cmd=='import-normalized':
        rows=json.load(open(args.path,encoding='utf8'))
        prices=json.load(open(args.price_config,encoding='utf8'))
        count=0
        for row in rows:
            # This is a NORMALIZED, OPERATOR-TRUSTED intermediate schema.
            # DO NOT feed untrusted consumer-submitted usage to this importer.
            wallet=ledger.key_for_caller_id(row['caller_key_id'])
            if not wallet:continue
            model=row['model']; price=prices.get(model)
            if price is None:continue
            amount=cost_nano(row['tokens'],price)
            ref=str(row['rid'])
            count+=int(ledger.charge_usage(wallet=wallet,request_id=ref,amount_nano=amount,
                         token_meta=json.dumps({'model':model,'tokens':row['tokens']},sort_keys=True)))
        print(f'imported {count} unique completed calls')

if __name__=='__main__':main()
