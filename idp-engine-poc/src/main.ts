import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { PinoNestLogger } from './common/logger';
import { APP_CONFIG, type AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  // Load .env before reading APP_ROLE; ConfigModule does not override variables already set.
  if (existsSync('.env')) process.loadEnvFile('.env');

  if (process.env.APP_ROLE === 'worker') {
    const ctx = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
    ctx.useLogger(ctx.get(PinoNestLogger));
    ctx.enableShutdownHooks();
    return;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const cfg = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(app.get(PinoNestLogger));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('IDP engine POC')
    .setDescription(
      'One extraction pipeline, swappable engines: Amazon Textract, VLM Run, Meibel (+ fake)',
    )
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));

  await app.listen(cfg.port);
}

void bootstrap();
