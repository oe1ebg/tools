"""Offline XSD cross-check. stdin XML, argv: generic|export; nonzero on errors."""
from pathlib import Path
import sys
import re
from lxml import etree

root = Path(__file__).resolve().parent.parent
schema_name = 'adx318generic.xsd' if len(sys.argv) > 1 and sys.argv[1] == 'generic' else 'adx318.xsd'
parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
schema_document = etree.parse(str(root / 'tests/fixtures/adif-spec' / schema_name), parser)
# Upstream 3.1.8.0 uses lookahead, which XML Schema 1.0 forbids, in
# Secondary_Administrative_Subdivision_Enumeration_Alt. Keep the official
# files unchanged: libxml2 checks the structural superset and Python's regex
# checks the ORIGINAL constraint as well. No constraint is discarded.
namespace = {'xs': 'http://www.w3.org/2001/XMLSchema'}
lookahead_patterns = []
for pattern in schema_document.xpath('//xs:pattern', namespaces=namespace):
    original = pattern.get('value')
    if '(?=' not in original:
        continue
    parent = pattern.getparent().getparent()
    if parent.get('name') != 'Secondary_Administrative_Subdivision_Enumeration_Alt' or original.count('(?=[a-zA-Z])') != 2:
        raise ValueError('Unexpected non-XSD regular expression in official schema')
    lookahead_patterns.append(re.compile(original))
    pattern.set('value', original.replace('(?=[a-zA-Z])', ''))
schema = etree.XMLSchema(schema_document)
try:
    document = etree.fromstring(sys.stdin.buffer.read(), parser)
    if document.getroottree().docinfo.doctype:
        raise ValueError('DOCTYPE is not permitted in ADX')
    # ADIF IV.B.1: XML namespaces and processing instructions are ignored.
    for element in document.iter():
        if isinstance(element.tag, str):
            element.tag = etree.QName(element).localname
            for attr in list(element.attrib):
                if attr.startswith('{'):
                    element.attrib[etree.QName(attr).localname] = element.attrib.pop(attr)
    schema.assertValid(document)
    for element in document.iter():
        if element.tag in ('CNTY_ALT', 'MY_CNTY_ALT'):
            for pattern in lookahead_patterns:
                if not pattern.search(element.text or ''):
                    raise ValueError(f'{element.tag}: does not match the original official NZ_REGIONS constraint')
except (etree.XMLSyntaxError, etree.DocumentInvalid, ValueError) as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)
