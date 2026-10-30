import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config';
import {
  makeBookingSheetPdf,
  makeCms1500Pdf,
  SYNTHETIC_BOOKING_PARAGRAPHS,
  SYNTHETIC_CARD_LINES,
  SYNTHETIC_CMS1500_LINES,
  SYNTHETIC_INTAKE_LINES,
  SYNTHETIC_LETTER_LINES,
  SYNTHETIC_UB04_LINES,
} from '../testing/synthetic-docs';
import { RasterizerService } from '../rasterizer/rasterizer.service';
import { classifyText } from './classifier';
import {
  BOOKING_SHEET,
  CMS1500,
  FORM_DEFINITIONS,
  GENERIC,
  INSURANCE_CARD,
  UB04,
} from './definitions';
import { resolvePath, validateForm, type FormDefinition } from './form-definition';
import { FormRegistry } from './form-registry';
import { buildJsonSchema, getAtPath, type JsonSchema } from './json-schema.builder';

describe('form definitions', () => {
  it('all built-in definitions are valid (Zod shape + semantic checks)', () => {
    expect(FORM_DEFINITIONS.flatMap(validateForm)).toEqual([]);
    expect(FORM_DEFINITIONS.map((f) => f.id)).toEqual([
      'CMS1500',
      'UB04',
      'BOOKING_SHEET',
      'INSURANCE_CARD',
      'PATIENT_INTAKE',
      'GENERIC',
    ]);
  });

  it('claim forms carry their line items as groups', () => {
    expect(CMS1500.groups![0]).toMatchObject({ path: 'serviceLines', maxRows: 6 });
    expect(UB04.groups![0]).toMatchObject({ path: 'revenueLines', maxRows: 22 });
    expect(BOOKING_SHEET.groups![0]).toMatchObject({ path: 'procedures' });
    expect(CMS1500.fields.filter((f) => f.path.startsWith('diagnosis.'))).toHaveLength(12);
  });

  it('rejects bad shapes, duplicate paths, conflicts, reserved paths and unknown canonical keys', () => {
    const bad = {
      id: 'BAD',
      version: 1,
      title: 'Bad',
      description: '',
      fields: [
        { path: 'a', label: 'A', type: 'text' },
        { path: 'a.b', label: 'AB', type: 'text', canonicalKey: 'not.a.key' },
        { path: 'a.b', label: 'AB again', type: 'text' },
        { path: 'otherFields', label: 'reserved', type: 'text' },
      ],
    };
    const errors = validateForm(bad).join('\n');
    expect(errors).toContain('DEF_PATH_DUP');
    expect(errors).toContain('DEF_PATH_CONFLICT');
    expect(errors).toContain('DEF_CANONICAL');
    expect(errors).toContain('DEF_PATH_RESERVED');
    expect(validateForm({ id: 'x', fields: 'nope' }).join()).toContain('DEF_SHAPE');
    expect(
      validateForm({
        ...INSURANCE_CARD,
        fields: [{ path: 'a', label: 'A', type: 'colour' }],
      }).join(),
    ).toContain('DEF_SHAPE');
  });

  it('registry: duplicates and a missing GENERIC fail at boot', () => {
    expect(() => FormRegistry.load([INSURANCE_CARD, INSURANCE_CARD, GENERIC])).toThrow(
      'DEF_ID_DUP',
    );
    expect(() => FormRegistry.load([INSURANCE_CARD])).toThrow('DEF_NO_GENERIC');
  });

  it('registry loads JSON forms from FORMS_DIR (a new form with zero code) and rejects bad ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forms-'));
    const referral: FormDefinition = {
      id: 'REFERRAL',
      version: 1,
      title: 'Referral letter',
      description: 'Synthetic referral form defined in JSON',
      cues: { phrases: ['REFERRAL', 'REFERRING PHYSICIAN'] },
      fields: [
        {
          path: 'patient.name',
          label: 'Patient name',
          type: 'name',
          canonicalKey: 'patient.name.full',
          keyAliases: ['PATIENT NAME'],
        },
      ],
    };
    writeFileSync(join(dir, 'referral.json'), JSON.stringify(referral));
    const registry = new FormRegistry({ formsDir: dir } as AppConfig);
    expect(registry.get('REFERRAL').title).toBe('Referral letter');
    expect(registry.has('CMS1500')).toBe(true);

    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ id: 'lower', fields: [] }));
    expect(() => new FormRegistry({ formsDir: dir } as AppConfig)).toThrow(/broken\.json/);
  });

  it('resolvePath maps scalars, group cells and other values', () => {
    expect(resolvePath(CMS1500, 'patient.dob')).toMatchObject({ kind: 'field' });
    expect(resolvePath(CMS1500, 'serviceLines[3].cptHcpcs')).toMatchObject({
      kind: 'group',
      row: 3,
      column: { canonicalKey: 'line.cpt_hcpcs' },
    });
    expect(resolvePath(CMS1500, 'otherFields[7]')).toEqual({ kind: 'other', index: 7 });
    expect(resolvePath(CMS1500, 'serviceLines[0].nope')).toBeNull();
    expect(resolvePath(CMS1500, 'made.up')).toBeNull();
  });
});

describe('buildJsonSchema', () => {
  it('scalars nested, groups as arrays with maxItems, otherFields capture, every key required + nullable', () => {
    const { schema } = buildJsonSchema(CMS1500);
    expect(schema.required).toEqual(
      expect.arrayContaining(['patient', 'insured', 'diagnosis', 'serviceLines', 'otherFields']),
    );
    const lines = schema.properties!.serviceLines!;
    expect(lines).toMatchObject({ type: 'array', maxItems: 6 });
    expect(lines.items!.required).toEqual(CMS1500.groups![0]!.columns.map((c) => c.path));
    expect(lines.items!.properties!.cptHcpcs!.type).toEqual(['string', 'null']);
    const other = schema.properties!.otherFields!;
    expect(other.items!.required).toEqual(['label', 'value']);
    expect(schema.properties!.patient!.properties!.dob!.type).toEqual(['string', 'null']);
  });

  it('checkboxes are booleans; GENERIC is only otherFields', () => {
    expect(
      (buildJsonSchema(BOOKING_SHEET).schema.properties!.latexAllergy as JsonSchema).type,
    ).toEqual(['boolean', 'null']);
    expect(Object.keys(buildJsonSchema(GENERIC).schema.properties!)).toEqual(['otherFields']);
  });

  it('descriptions carry labels only (no example values -> no PHI in prompts)', () => {
    for (const form of FORM_DEFINITIONS) {
      const text = JSON.stringify(buildJsonSchema(form).schema);
      expect(text).not.toMatch(/example|e\.g\./i);
      expect(text).not.toMatch(/\d{5,}/);
    }
  });

  it('hash is stable and changes when the schema changes', () => {
    const a = buildJsonSchema(UB04).schemaHash;
    expect(buildJsonSchema(structuredClone(UB04)).schemaHash).toBe(a);
    expect(buildJsonSchema({ ...UB04, fields: UB04.fields.slice(1) }).schemaHash).not.toBe(a);
  });

  it('getAtPath reads nested values', () => {
    expect(getAtPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(getAtPath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('classifyText (cue scoring)', () => {
  const forms = FORM_DEFINITIONS;
  it.each([
    ['CMS1500', SYNTHETIC_CMS1500_LINES],
    ['UB04', SYNTHETIC_UB04_LINES],
    ['BOOKING_SHEET', [...SYNTHETIC_BOOKING_PARAGRAPHS, 'CPT | Procedure | Side']],
    ['INSURANCE_CARD', SYNTHETIC_CARD_LINES],
    ['PATIENT_INTAKE', SYNTHETIC_INTAKE_LINES],
  ])('detects %s', (expected, lines) => {
    const c = classifyText(lines.join('\n'), forms);
    expect(c).toMatchObject({ formType: expected, source: 'classifier', hadText: true });
    expect(c.scores[0]!.formType).toBe(expected);
  });

  it('unknown documents and empty text fall back to GENERIC', () => {
    expect(classifyText(SYNTHETIC_LETTER_LINES.join('\n'), forms)).toMatchObject({
      formType: 'GENERIC',
      source: 'fallback',
    });
    expect(classifyText('', forms)).toMatchObject({
      formType: 'GENERIC',
      source: 'fallback',
      hadText: false,
    });
  });

  it('works on the text layer of rendered PDFs', async () => {
    const raster = new RasterizerService({ upload: { rasterDpi: 72 } } as AppConfig);
    for (const [pdf, expected] of [
      [makeCms1500Pdf(), 'CMS1500'],
      [makeBookingSheetPdf(), 'BOOKING_SHEET'],
    ] as const) {
      const pages = await raster.rasterize(pdf, 'application/pdf');
      expect(classifyText(pages.map((p) => p.text).join('\n'), forms).formType).toBe(expected);
    }
  });
});
