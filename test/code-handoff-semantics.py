#!/usr/bin/env python3
"""Exercise real handoff schemas with synthetic data; never run reported commands.

Run from any directory with Node >=22 and the locked test-only requirements.
This is regression verification, not hosted acceptance or evidence authentication.
"""
from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry
from referencing.exceptions import NoSuchResource

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / 'integrations/codex/projects-pack-delegation/contracts'
DIALECT = 'https://json-schema.org/draft/2020-12/schema'

# Require the reviewed dependency versions even when invoked outside CI. Missing
# packages, invalid schemas, malformed output and subprocess errors are failures,
# never reasons to skip the semantic tests or report success.
for line in (ROOT / 'test/requirements-handoff.txt').read_text(encoding='utf-8').splitlines():
    pin = re.match(r'^([A-Za-z0-9_.-]+)==([A-Za-z0-9.]+)', line)
    if pin and version(pin[1]) != pin[2]:
        raise SystemExit(f'Install the locked handoff test requirements: {pin[1]} version differs.')

baseline = json.loads((CONTRACTS / 'worker-handoff.schema.json').read_text(encoding='utf-8'))
assignment = {'packId': 'wp-02-code', 'workerId': 'worker-1', 'verificationCommand': 'npm run check'}
assignments = [assignment, {**assignment, 'verificationCommand': 'x' * 500},
               {**assignment, 'verificationCommand': '\U0001f600' * 500},
               {**assignment, 'packId': 'wp-03-code', 'verificationCommand': 'npm test'}]
# Fixed source, shell=False, bounded execution. Assignment strings go through
# JSON stdin only; no reported verification command is interpolated or executed.
js = """
import { createCodeHandoffAcceptanceSchema } from './integrations/codex/projects-pack-delegation/contracts/code-handoff-acceptance.mjs';
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node >=22 required');
let data = '';
for await (const chunk of process.stdin) data += chunk;
process.stdout.write(JSON.stringify(JSON.parse(data).map(createCodeHandoffAcceptanceSchema)));
"""
completed = subprocess.run(['node', '--input-type=module', '-e', js], cwd=ROOT,
                           input=json.dumps(assignments), text=True, encoding='utf-8',
                           capture_output=True, timeout=30, check=True, shell=False)
profiles = json.loads(completed.stdout)
if not isinstance(profiles, list) or len(profiles) != len(assignments):
    raise SystemExit('Builder did not return one schema per assignment.')
for schema in [baseline, *profiles]:
    if not isinstance(schema, dict) or schema.get('$schema') != DIALECT:
        raise SystemExit('Expected an explicit Draft 2020-12 schema object.')
    Draft202012Validator.check_schema(schema)

def deny_external_reference(uri):
    """Self-contained contract validation must not retrieve external resources."""
    raise NoSuchResource(ref=uri)

registry = Registry(retrieve=deny_external_reference)
validators = [Draft202012Validator(schema, registry=registry) for schema in profiles]
base_validator = Draft202012Validator(baseline, registry=registry)

report = {
    'schemaVersion': 1, 'packId': assignment['packId'], 'workerId': assignment['workerId'],
    'status': 'completed', 'filesChanged': ['src/example.mjs'],
    'tests': [{'command': 'npm run check', 'passed': True, 'note': None}],
    'summary': 'Synthetic regression fixture; no command was executed.',
    'blocker': None, 'completionEvidence': 'Synthetic evidence for schema validation only.',
    'createdAt': '2026-09-11T12:00:00.000Z'
}
cases = []
def add(name, value, expected_base, expected_profile, profile_index=0):
    cases.append((name, value, expected_base, expected_profile, profile_index))
def changed(**kwargs):
    return {**copy.deepcopy(report), **kwargs}
def with_test(**kwargs):
    value = copy.deepcopy(report)
    value['tests'][0].update(kwargs)
    return value

add('valid_completed_code_report', report, True, True)
add('completed_empty_tests', changed(tests=[]), True, False)
add('completed_unrelated_passed_command', with_test(command='node --version'), True, False)
add('required_command_missing_but_two_other_tests_passed', changed(tests=[
    {'command':'npm test', 'passed': True, 'note': None},
    {'command':'npm run build', 'passed': True, 'note': None}]), True, False)
add('exact_required_command_after_unrelated_passed_command', changed(tests=[
    {'command':'npm run build', 'passed': True, 'note': None},
    report['tests'][0]]), True, True)
add('exact_required_command_with_additional_failed_test', changed(tests=[
    report['tests'][0], {'command':'npm run build', 'passed': False, 'note': 'Synthetic failure.'}]), False, False)
add('required_command_reported_failed', with_test(passed=False), False, False)
add('reported_passed_not_boolean', with_test(passed='true'), False, False)
add('command_missing_from_test', changed(tests=[{'passed': True, 'note': None}]), False, False)
add('command_has_trailing_space', with_test(command='npm run check '), True, False)
add('command_has_leading_space', with_test(command=' npm run check'), True, False)
add('command_case_substitution', with_test(command='NPM run check'), True, False)
for label, evidence, expected_base in [
    ('empty', '', False), ('space', ' ', True), ('tabs_newlines', '\t\r\n', True),
    ('nbsp', '\u00a0', True), ('emspace', '\u2003', True), ('bom', '\ufeff', True),
    ('mixed_whitespace', ' \ufeff\t\n', True), ('null', None, False), ('nonstring', 42, False)
]:
    add(f'completion_evidence_{label}', changed(completionEvidence=evidence), expected_base, False)
add('evidence_surrounded_by_whitespace', changed(completionEvidence='\n Verified fixture \n'), True, True)
add('pack_identity_mismatch', changed(packId='other-pack'), True, False)
add('worker_identity_mismatch', changed(workerId='other-worker'), True, False)
add('null_blocker_required_for_completed', changed(blocker='Pending review.'), False, False)
add('blocked_report_still_valid_v1_but_not_code_acceptance', changed(
    status='blocked', blocker='Waiting for access.', completionEvidence=None, tests=[]), True, False)
add('failed_report_still_valid_v1_but_not_code_acceptance', changed(
    status='failed', blocker='Synthetic failure.', completionEvidence=None,
    tests=[{'command':'npm run check', 'passed':False, 'note':'Fixture.'}]), True, False)
add('extra_top_level_field', changed(headSha='a' * 40), False, False)
add('incorrect_schema_version', changed(schemaVersion=2), False, False)
add('relative_path_parent_traversal', changed(filesChanged=['../outside.mjs']), False, False)
add('posix_absolute_path', changed(filesChanged=['/outside.mjs']), False, False)
add('windows_absolute_path', changed(filesChanged=['C:\\outside.mjs']), False, False)
add('duplicate_changed_paths', changed(filesChanged=['src/example.mjs', 'src/example.mjs']), False, False)
add('no_changed_files_is_not_automatically_rejected', changed(filesChanged=[]), True, True)
add('500_ascii_character_command_roundtrips', with_test(command='x' * 500), True, True, 1)
add('501_ascii_character_command_not_representable_in_v1', with_test(command='x' * 501), False, False, 1)
add('600_ascii_character_command_not_representable_in_v1', with_test(command='x' * 600), False, False, 1)
add('2000_ascii_character_command_not_representable_in_v1', with_test(command='x' * 2000), False, False, 1)
add('500_supplementary_unicode_code_points_roundtrip', with_test(command='\U0001f600' * 500), True, True, 2)
add('501_supplementary_unicode_code_points_fail', with_test(command='\U0001f600' * 501), False, False, 2)
add('old_assignment_report_does_not_fit_second_profile', report, True, False, 3)
add('second_assignment_own_report_fits_second_profile', changed(
    packId='wp-03-code', tests=[{'command':'npm test', 'passed':True, 'note':None}]), True, True, 3)


# Exercise every required field and important collection/type boundaries.
for field in baseline['required']:
    missing = copy.deepcopy(report)
    del missing[field]
    add(f'missing_required_{field}', missing, False, False)
add('nonobject_report', [], False, False)
add('tests_null', changed(tests=None), False, False)
add('unknown_test_property', with_test(extra=True), False, False)
add('tests_at_128_limit', changed(tests=[report['tests'][0]] * 128), True, True)
add('tests_over_128_limit', changed(tests=[report['tests'][0]] * 129), False, False)
add('files_at_256_limit', changed(filesChanged=[f'src/{i}.mjs' for i in range(256)]), True, True)
add('files_over_256_limit', changed(filesChanged=[f'src/{i}.mjs' for i in range(257)]), False, False)
add('evidence_at_2000_limit', changed(completionEvidence='e' * 2000), True, True)
add('evidence_over_2000_limit', changed(completionEvidence='e' * 2001), False, False)
add('test_note_empty', with_test(note=''), False, False)
add('test_note_missing', changed(tests=[{'command': 'npm run check', 'passed': True}]), False, False)
add('nested_parent_traversal', changed(filesChanged=['src/../outside.mjs']), False, False)
add('backslash_path', changed(filesChanged=['src\\example.mjs']), False, False)

if not cases or len({case[0] for case in cases}) != len(cases):
    raise SystemExit('Semantic cases must be nonempty and uniquely named.')

results = []
for name, payload, expected_base, expected_profile, index in cases:
    before = copy.deepcopy(payload)
    actual_base = base_validator.is_valid(payload)
    errors = list(validators[index].iter_errors(payload))
    actual_profile = not errors
    results.append({
        'case': name,
        'baseline_accepts': actual_base,
        'profile_accepts': actual_profile,
        'passed': (actual_base == expected_base and actual_profile == expected_profile
                   and payload == before),
        # Locations and keywords are enough to diagnose synthetic failures.
        # Do not serialize validator messages which can echo entire payloads.
        'error_locations': [{'path': list(e.absolute_path), 'keyword': e.validator} for e in errors]
    })

# Prove the negative fixtures detect specific weakenings rather than only
# validating schema syntax. These copies never replace source or live policy.
mutations = []
for name, field in [('pack_binding_removed', 'packId'),
                    ('worker_binding_removed', 'workerId'),
                    ('nonblank_evidence_removed', 'completionEvidence'),
                    ('required_command_removed', 'tests')]:
    weakened = copy.deepcopy(profiles[0])
    del weakened['allOf'][-1]['properties'][field]
    mutations.append((name, weakened))
# Merely removing status is redundant: v1 requires null evidence for blocked or
# failed reports. Remove the completed-only overlay together to exercise that
# transition; do not falsely expect a redundant-key deletion to change behavior.
weakened = copy.deepcopy(profiles[0])
for field in ['status', 'completionEvidence', 'tests']:
    del weakened['allOf'][-1]['properties'][field]
mutations.append(('noncompleted_reports_allowed', weakened))
mutations.append(('baseline_used_instead_of_profile', copy.deepcopy(baseline)))
weakened = copy.deepcopy(profiles[0])
weakened['additionalProperties'] = True
mutations.append(('unknown_fields_allowed', weakened))

mutation_results = []
for name, weakened in mutations:
    Draft202012Validator.check_schema(weakened)
    validator = Draft202012Validator(weakened, registry=registry)
    detected_by = [case_name for case_name, payload, _, expected, index in cases
                   if index == 0 and validator.is_valid(payload) != expected]
    mutation_results.append({'mutation': name, 'passed': bool(detected_by), 'detected_by': detected_by})

failed = [result for result in results if not result['passed']]
missed = [result for result in mutation_results if not result['passed']]
summary = {
    'scope': 'Synthetic contract regression tests; reported commands are not executed.',
    'validator': {'name': 'python-jsonschema', 'version': version('jsonschema'), 'dialect': '2020-12'},
    'schema_documents_checked': 1 + len(profiles),
    'payload_cases': len(results), 'payload_passed': len(results) - len(failed),
    'payload_failed': len(failed), 'weakening_mutations': len(mutation_results),
    'mutations_detected': len(mutation_results) - len(missed),
    'failed_cases': failed, 'mutation_results': mutation_results
}
print(json.dumps(summary, indent=2))
sys.exit(1 if failed or missed else 0)
