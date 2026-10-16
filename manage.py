#!/usr/bin/env python3
"""Server-admin maintenance. Run from the local installation."""
import argparse,getpass,os,sqlite3
from pathlib import Path
from server import password_hash,email_address
p=argparse.ArgumentParser(description='LabTeX server maintenance')
p.add_argument('command',choices=['backup','reset-password'])
p.add_argument('value',help='Backup destination path, or account email for reset-password')
a=p.parse_args()
os.umask(0o077)
data=Path(os.getenv('DATA_DIR',str(Path(__file__).resolve().parent/'data')))
dbpath=data/'labtex.sqlite3'
if not dbpath.is_file():p.error('No database found. Start the server first.')
with sqlite3.connect(dbpath) as db:
    if a.command=='backup':
        destination=Path(a.value).resolve()
        if destination==dbpath.resolve() or destination.exists():p.error('Choose a new backup file path.')
        with sqlite3.connect(destination) as out:db.backup(out)
        os.chmod(destination,0o600)
        print('Consistent SQLite backup created at '+str(destination))
    else:
        email=email_address(a.value);row=db.execute('SELECT id FROM users WHERE email=?',(email,)).fetchone()
        if not row:p.error('Account not found.')
        password=getpass.getpass('New password (at least 12 characters): ')
        if password!=getpass.getpass('Confirm new password: '):p.error('Passwords differ.')
        db.execute('UPDATE users SET password=? WHERE id=?',(password_hash(password),row[0]))
        db.execute('DELETE FROM sessions WHERE user_id=?',(row[0],))
        print('Password updated; existing sessions revoked.')
