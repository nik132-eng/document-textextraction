import { describe, expect, it } from 'vitest';
import { FORM_DEFINITIONS, INSURANCE_CARD, PATIENT_INTAKE } from './definitions';
import { validateForm, type FormDefinition } from './form-definition';
import { FormRegistry } from './form-registry';
import { buildJsonSchema, getAtPath } from './json-schema.builder';

describe('form definitions', () => {
  it('all shipped definitions are valid', () => {
    expect(FORM_DEFINITIONS.flatMap(validateForm)).toEqual([]);
  });

  it('rejects duplicate paths, leaf/parent conflicts, unknown canonical keys and >15 queries', () => {
    const bad: FormDefinition = {
      id: 'BAD',
      version: 1,
      title: 'Bad',
      description: '',
      fields: [
        { path: 'a', label: 'A', type: 'text' },
        { path: 'a.b', label: 'AB', type: 'text', canonicalKey: 'not.a.key' },
        { path: 'a.b', label: 'AB again', type: 'text' },
        ...Array.from({ length: 14 }, (_, i) => ({
          path: `q${i}`,
          label: `Q${i}`,
          type: 'text' as const,
        })),
      ],
    };
    const errors = validateForm(bad).join('\n');
    expect(errors).toContain('DEF_PATH_DUP');
    expect(errors).toContain('DEF_PATH_CONFLICT');
    expect(errors).toContain('DEF_CANONICAL');
    expect(errors).toContain('DEF_QUERY_LIMIT');
  });

  it('registry refuses to load invalid definitions (fail at boot)', () => {
    expect(() => FormRegistry.load([INSURANCE_CARD, INSURANCE_CARD])).toThrow('DEF_ID_DUP');
  });
});

describe('buildJsonSchema', () => {
  it('nests dot paths, makes every key required and nullable, checkboxes boolean', () => {
    const { schema } = buildJsonSchema(PATIENT_INTAKE);
    const patient = schema.properties!.patient!;
    expect(patient.type).toBe('object');
    expect(patient.required).toEqual(['lastName', 'firstName', 'dob', 'sex', 'phone']);
    expect(patient.properties!.dob!.type).toEqual(['string', 'null']);
    expect(schema.properties!.insurance!.properties!.subscriberIsPatient!.type).toEqual([
      'boolean',
      'null',
    ]);
    expect(schema.required).toEqual(['patient', 'address', 'insurance']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('descriptions carry labels only (no example values -> no PHI in prompts)', () => {
    const text = JSON.stringify(buildJsonSchema(INSURANCE_CARD).schema);
    expect(text).not.toMatch(/example|e\.g\./i);
    expect(text).not.toMatch(/\d{4,}/);
  });

  it('hash is stable and changes when the schema changes', () => {
    const a = buildJsonSchema(INSURANCE_CARD).schemaHash;
    expect(buildJsonSchema(structuredClone(INSURANCE_CARD)).schemaHash).toBe(a);
    const changed = { ...INSURANCE_CARD, fields: INSURANCE_CARD.fields.slice(1) };
    expect(buildJsonSchema(changed).schemaHash).not.toBe(a);
  });

  it('getAtPath reads nested values', () => {
    expect(getAtPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(getAtPath({ a: null }, 'a.b')).toBeUndefined();
  });
});
