"""Bounded DOI metadata lookup. Only fixed registry API hosts are contacted."""
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from core import Problem


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def normalize_doi(value):
    if not isinstance(value, str):
        raise Problem('Enter a DOI or doi.org link.')
    doi = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', value.strip(), flags=re.I)
    if not re.fullmatch(r'10\.\d{4,9}/[^\s\x00-\x1f\x7f]{1,220}', doi):
        raise Problem('Enter a DOI such as 10.5555/example.')
    return doi


def fetch(url, accept):
    req = urllib.request.Request(url, headers={'Accept': accept, 'User-Agent': 'IDSL-Editor/DOI-import'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=12) as response:
            raw = response.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise Problem('The DOI record is too large.', 413)
        return raw.decode('utf-8')
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise Problem('The DOI registry could not return this record. Try again later.', 502) from None
    except (OSError, UnicodeError):
        raise Problem('The DOI registry is unavailable. Your project has not changed.', 502) from None


def lookup_doi(value):
    doi = normalize_doi(value)
    encoded = urllib.parse.quote(doi, safe='')
    bibtex = fetch('https://api.crossref.org/works/' + encoded + '/transform/application/x-bibtex', 'application/x-bibtex')
    if bibtex is not None:
        if not re.match(r'\s*@[A-Za-z]+\s*[{(]', bibtex):
            raise Problem('The registry returned an invalid BibTeX record.', 502)
        return {'doi': doi, 'bibtex': bibtex.strip() + '\n', 'provider': 'Crossref'}
    raw = fetch('https://api.datacite.org/dois/' + encoded, 'application/vnd.api+json')
    if raw is None:
        raise Problem('No record found in Crossref or DataCite for this DOI.', 404)
    try:
        record = json.loads(raw)['data']['attributes']
        clean = lambda text: re.sub(r'[{}\\\r\n]', ' ', str(text)).strip()
        authors = ' and '.join(clean(item.get('familyName', item.get('name', 'Unknown'))) + (', ' + clean(item['givenName']) if item.get('givenName') else '') for item in record.get('creators', []))
        key = re.sub(r'[^A-Za-z0-9_-]', '', authors.split(',')[0].split(' ')[0])[:40] + str(record.get('publicationYear', ''))
        fields = {'title': clean(record['titles'][0]['title']), 'author': authors, 'year': clean(record.get('publicationYear', '')), 'publisher': clean(record.get('publisher', '')), 'doi': doi}
        bibtex = '@misc{' + (key or 'reference') + ',\n' + ',\n'.join('  ' + name + ' = {' + text + '}' for name, text in fields.items() if text) + '\n}\n'
    except (ValueError, KeyError, TypeError, IndexError):
        raise Problem('The DOI registry returned incomplete metadata.', 502) from None
    return {'doi': doi, 'bibtex': bibtex, 'provider': 'DataCite'}
