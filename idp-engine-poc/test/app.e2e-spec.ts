import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { makeSyntheticCardPng, makeSyntheticPdf } from '../src/testing/synthetic-docs';

/**
 * Full HTTP flow on real Postgres with the fake engine (no vendor calls, no credentials):
 * upload -> rasterize -> extract -> flags -> reuse -> compare.
 * Needs: docker compose up -d && pnpm prisma:deploy
 * Env overrides below are read when providers are instantiated (in beforeAll), not at import time.
 */
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.ENGINES_ENABLED = 'fake';
process.env.ENGINE_DEFAULT = 'fake';
process.env.PIPELINE_MODE = 'sync';
process.env.PHI_MODE = 'false';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_DIR = './.data-e2e';
process.env.LOG_LEVEL = 'warn';

describe('IDP POC (e2e, fake engine)', () => {
  let app: INestApplication;
  const tenant = `e2e-${Date.now()}`;

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

  it('GET /health is up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /v1/engines lists all four, only fake enabled', async () => {
    const res = await request(app.getHttpServer()).get('/v1/engines').expect(200);
    expect(res.body).toEqual([
      { name: 'fake', enabled: true, default: true },
      { name: 'textract', enabled: false, default: false },
      { name: 'vlmrun', enabled: false, default: false },
      { name: 'meibel', enabled: false, default: false },
    ]);
  });

  it('requires x-tenant-id', async () => {
    await request(app.getHttpServer())
      .get('/v1/documents/00000000-0000-0000-0000-000000000000')
      .expect(400);
  });

  it('upload card -> extraction with fields, flags and provenance; re-upload is deduplicated and reused', async () => {
    const png = await makeSyntheticCardPng();
    const up = await request(app.getHttpServer())
      .post('/v1/documents')
      .set('x-tenant-id', tenant)
      .field('formType', 'INSURANCE_CARD')
      .attach('file', png, 'card.png')
      .expect(202);
    expect(up.body).toMatchObject({
      deduplicated: false,
      pageCount: 1,
      formType: 'INSURANCE_CARD',
    });
    const [ex] = up.body.extractions;
    expect(ex).toMatchObject({
      engine: 'fake',
      status: 'SUCCEEDED',
      needsReview: true,
      reused: false,
    });

    const detail = await request(app.getHttpServer())
      .get(`/v1/extractions/${ex.id}`)
      .set('x-tenant-id', tenant)
      .expect(200);
    expect(detail.body.fields).toHaveLength(10);
    expect(detail.body.fields[0]).toMatchObject({
      path: 'payer.name',
      canonicalKey: 'payer.name',
      page: 1,
      flags: [],
    });
    expect(detail.body.fields[3]).toMatchObject({
      path: 'member.id',
      confidence: 55,
      flags: ['low_confidence'],
    });

    const again = await request(app.getHttpServer())
      .post('/v1/documents')
      .set('x-tenant-id', tenant)
      .field('formType', 'INSURANCE_CARD')
      .attach('file', png, 'card.png')
      .expect(202);
    expect(again.body.documentId).toBe(up.body.documentId);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.extractions[0]).toMatchObject({ id: ex.id, reused: true });

    const page = await request(app.getHttpServer())
      .get(`/v1/documents/${up.body.documentId}/pages/1`)
      .set('x-tenant-id', tenant)
      .expect(200);
    expect(page.headers['content-type']).toBe('image/png');

    const cmp = await request(app.getHttpServer())
      .get(`/v1/documents/${up.body.documentId}/compare`)
      .set('x-tenant-id', tenant)
      .expect(200);
    expect(cmp.body).toMatchObject({ engines: ['fake'], formType: 'INSURANCE_CARD' });
    expect(cmp.body.rows).toHaveLength(10);
  });

  it('tenant isolation: another tenant cannot read the document', async () => {
    const up = await request(app.getHttpServer())
      .post('/v1/documents')
      .set('x-tenant-id', tenant)
      .field('formType', 'PATIENT_INTAKE')
      .attach('file', makeSyntheticPdf(), 'intake.pdf')
      .expect(202);
    expect(up.body.pageCount).toBe(1);
    await request(app.getHttpServer())
      .get(`/v1/documents/${up.body.documentId}`)
      .set('x-tenant-id', `${tenant}-other`)
      .expect(404);
  });

  it('rejects disabled engines, unknown forms and non-documents', async () => {
    const png = await makeSyntheticCardPng(['x']);
    await request(app.getHttpServer())
      .post('/v1/documents')
      .set('x-tenant-id', tenant)
      .field('formType', 'INSURANCE_CARD')
      .field('engines', 'vlmrun')
      .attach('file', png, 'a.png')
      .expect(400);
    await request(app.getHttpServer())
      .post('/v1/documents')
      .set('x-tenant-id', tenant)
      .field('formType', 'NOPE')
      .attach('file', png, 'a.png')
      .expect(404);
    await request(app.getHttpServer())
      .post('/v1/documents')
      .set('x-tenant-id', tenant)
      .field('formType', 'INSURANCE_CARD')
      .attach('file', Buffer.from('hello world'), 'a.txt')
      .expect(415);
  });
});
