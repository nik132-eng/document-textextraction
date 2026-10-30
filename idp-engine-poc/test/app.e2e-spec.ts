import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import {
  makeBookingSheetDocx,
  makeCms1500Pdf,
  makeLetterPdf,
  makeSyntheticCardPng,
  makeSyntheticPdf,
  makeUb04Pdf,
} from '../src/testing/synthetic-docs';

/**
 * Full HTTP flow on real Postgres with the fake engine (no vendor calls, no credentials):
 * any file -> convert -> classify -> extract (scalars + groups + other values) -> compare.
 * Needs: docker compose up -d && pnpm prisma:deploy
 * Env overrides below are read when providers are instantiated (in beforeAll), not at import time.
 */
if (existsSync('.env')) process.loadEnvFile('.env');
Object.assign(process.env, {
  ENGINES_ENABLED: 'fake',
  ENGINE_DEFAULT: 'fake',
  PIPELINE_MODE: 'sync',
  PHI_MODE: 'false',
  STORAGE_DRIVER: 'local',
  STORAGE_DIR: './.data-e2e',
  LOG_LEVEL: 'warn',
  CLASSIFY_OCR: 'none',
  FORMS_DIR: join(__dirname, 'fixtures/forms'),
});

describe('IDP POC (e2e, fake engine)', () => {
  let app: INestApplication;
  const tenant = `e2e-${Date.now()}`;
  const http = () => request(app.getHttpServer());
  const upload = (file: Buffer, name: string, fields: Record<string, string> = {}) => {
    const req = http().post('/v1/documents').set('x-tenant-id', tenant);
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req.attach('file', file, name);
  };
  const extraction = async (id: string) =>
    (await http().get(`/v1/extractions/${id}`).set('x-tenant-id', tenant).expect(200)).body;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await rm('./.data-e2e', { recursive: true, force: true });
  });

  it('health, engines, and forms (built-in + JSON from FORMS_DIR)', async () => {
    expect((await http().get('/health').expect(200)).body.status).toBe('ok');
    const engines = (await http().get('/v1/engines').expect(200)).body;
    expect(
      engines.filter((e: { enabled: boolean }) => e.enabled).map((e: { name: string }) => e.name),
    ).toEqual(['fake']);
    const forms = (await http().get('/v1/forms').expect(200)).body.map((f: { id: string }) => f.id);
    expect(forms).toEqual(
      expect.arrayContaining(['CMS1500', 'UB04', 'BOOKING_SHEET', 'GENERIC', 'REFERRAL']),
    );
    const cms = (await http().get('/v1/forms/CMS1500').expect(200)).body;
    expect(cms.jsonSchema.schema.properties.serviceLines.maxItems).toBe(6);
  });

  it('CMS-1500 PDF with no formType -> auto-classified, header fields + Box 24 rows + other values', async () => {
    const res = (await upload(makeCms1500Pdf(), 'claim.pdf').expect(202)).body;
    expect(res).toMatchObject({
      formType: 'CMS1500',
      conversion: 'none',
      mimeType: 'application/pdf',
    });
    expect(res.classification).toMatchObject({
      formType: 'CMS1500',
      source: 'classifier',
      hadText: true,
    });
    const ex = await extraction(res.extractions[0].id);
    expect(ex.status).toBe('SUCCEEDED');
    expect(ex.fields.find((f: { path: string }) => f.path === 'insured.id')).toMatchObject({
      canonicalKey: 'insured.id',
      page: 1,
    });
    expect(ex.groups.serviceLines).toHaveLength(2);
    expect(ex.groups.serviceLines[0].map((c: { path: string }) => c.path)).toContain(
      'serviceLines[0].cptHcpcs',
    );
    expect(ex.other).toHaveLength(2);
    expect(ex.other[0].flags).toContain('unmapped');
    // values: the form's JSON shape, ready for prefill.
    expect(ex.values.serviceLines[1].cptHcpcs).toMatch(/SYNTH 2/);
    expect(ex.values.patient.dob).toMatch(/SYNTHETIC/);
    expect(ex.values.otherFields[0]).toEqual({
      label: 'SYNTHETIC EXTRA LABEL',
      value: 'SYNTHETIC EXTRA VALUE',
    });
  });

  it('UB-04 PDF -> UB04 with revenue lines', async () => {
    const res = (await upload(makeUb04Pdf(), 'ub.pdf').expect(202)).body;
    expect(res.formType).toBe('UB04');
    expect((await extraction(res.extractions[0].id)).groups.revenueLines).toHaveLength(2);
  });

  it('Word booking sheet (.docx) -> converted to PDF, classified BOOKING_SHEET, procedures extracted, page PNG served', async () => {
    const res = (await upload(makeBookingSheetDocx(), 'booking.docx').expect(202)).body;
    expect(res).toMatchObject({
      formType: 'BOOKING_SHEET',
      conversion: 'docx-text',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const ex = await extraction(res.extractions[0].id);
    expect(ex.groups.procedures).toHaveLength(2);
    expect(ex.fields.find((f: { path: string }) => f.path === 'latexAllergy').value).toBe(false);
    const page = await http()
      .get(`/v1/documents/${res.documentId}/pages/1`)
      .set('x-tenant-id', tenant)
      .expect(200);
    expect(page.headers['content-type']).toBe('image/png');
  });

  it('unknown document -> GENERIC: every labelled value as other values', async () => {
    const res = (await upload(makeLetterPdf(), 'letter.pdf').expect(202)).body;
    expect(res.classification).toMatchObject({ formType: 'GENERIC', source: 'fallback' });
    const ex = await extraction(res.extractions[0].id);
    expect(ex.fields).toEqual([]);
    expect(ex.other.length).toBeGreaterThan(0);
  });

  it('scan without text layer and no OCR -> GENERIC; a formType hint overrides classification', async () => {
    const png = await makeSyntheticCardPng();
    expect((await upload(png, 'card.png').expect(202)).body.classification).toMatchObject({
      formType: 'GENERIC',
      hadText: false,
    });
    const other = await makeSyntheticCardPng(['SYNTHETIC CARD 2', 'Member ID: ZZX2']);
    const hinted = (await upload(other, 'card2.png', { formType: 'INSURANCE_CARD' }).expect(202))
      .body;
    expect(hinted).toMatchObject({
      formType: 'INSURANCE_CARD',
      classification: { source: 'hint' },
    });
  });

  it('a JSON-defined form (FORMS_DIR) is classified and extracted with no code change', async () => {
    const pdf = makeSyntheticPdf([
      'REFERRAL (SYNTHETIC)',
      'Patient name: JANE SAMPLE',
      'Referring physician: DR SAMPLE',
      'Reason for referral: synthetic test',
    ]);
    const res = (await upload(pdf, 'referral.pdf').expect(202)).body;
    expect(res.formType).toBe('REFERRAL');
    const ex = await extraction(res.extractions[0].id);
    expect(ex.fields.map((f: { path: string }) => f.path)).toEqual([
      'patient.name',
      'patient.dob',
      'referringPhysician',
      'reason',
    ]);
  });

  it('re-upload is deduplicated and the identical run reused; compare lists group rows', async () => {
    const first = (await upload(makeCms1500Pdf(), 'claim.pdf').expect(202)).body;
    expect(first.deduplicated).toBe(true);
    expect(first.extractions[0].reused).toBe(true);
    const cmp = (
      await http()
        .get(`/v1/documents/${first.documentId}/compare`)
        .set('x-tenant-id', tenant)
        .expect(200)
    ).body;
    expect(cmp.engines).toEqual(['fake']);
    expect(cmp.totals[0]).toMatchObject({ groupRows: 2, otherValues: 2 });
    expect(cmp.rows.some((r: { key: string }) => r.key === 'serviceLines[0].cptHcpcs')).toBe(true);
  });

  it('tenant isolation', async () => {
    const res = (await upload(makeSyntheticPdf(['tenant isolation sample']), 'x.pdf').expect(202))
      .body;
    await http()
      .get(`/v1/documents/${res.documentId}`)
      .set('x-tenant-id', `${tenant}-other`)
      .expect(404);
    await http().get(`/v1/documents/${res.documentId}`).expect(400);
  });

  it('rejects disabled engines, unknown forms, and unsupported files (txt, rtf, legacy doc)', async () => {
    const pdf = makeSyntheticPdf(['reject cases']);
    await upload(pdf, 'a.pdf', { engines: 'vlmrun' }).expect(400);
    await upload(pdf, 'a.pdf', { formType: 'NOPE' }).expect(404);
    await upload(Buffer.from('hello world, plain text'), 'a.txt').expect(415);
    const rtf = await upload(Buffer.from('{\\rtf1\\ansi synthetic}'), 'a.rtf').expect(415);
    expect(rtf.body.message).toMatch(/DOCX/);
    await upload(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
      'a.doc',
    ).expect(415);
  });
});
