"""Validate metadata-smoke output with independent upstream consumers.

Install jsonschema==4.26.0 and in-toto-attestation==0.9.3 in a disposable venv.
Pass the export directory and SPDX v2.3 schemas/spdx-schema.json as arguments.
"""
import json, pathlib, sys
import jsonschema
from google.protobuf.json_format import ParseDict
from in_toto_attestation.v1.statement_pb2 import Statement as StatementPB
from in_toto_attestation.v1.statement import Statement
from in_toto_attestation.predicates.provenance.v1.provenance_pb2 import Provenance
root = pathlib.Path(sys.argv[1])
schema = json.loads(pathlib.Path(sys.argv[2]).read_text())
checked=[]
for file in root.glob('*.json'):
    if file.name.endswith('.spdx.json'):
        jsonschema.Draft7Validator(schema).validate(json.loads(file.read_text()))
        checked.append('SPDX 2.3 JSON schema')
    elif file.name.endswith('.provenance.json'):
        value=json.loads(file.read_text())
        Statement.copy_from_pb(ParseDict(value, StatementPB())).validate()
        ParseDict(value['predicate'], Provenance())
        checked.append('in-toto-attestation 0.9.3 Statement validation and SLSA v1 protobuf parsing')
assert len(checked) == 2, checked
print(json.dumps({'validators': checked, 'result':'pass'}))
