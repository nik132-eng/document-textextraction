import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TerminusModule } from '@nestjs/terminus';
import { APP_CONFIG, type AppConfig, validateEnv } from './config/app-config';
import { CoreModule } from './core.module';
import { CompareService } from './documents/compare.service';
import {
  CatalogController,
  DocumentsController,
  ExtractionsController,
} from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { EnginesModule } from './engines/engines.module';
import { ExtractionDispatcher } from './extraction/extraction.dispatcher';
import { ExtractionRunner } from './extraction/extraction.runner';
import { HealthController } from './health.controller';

@Module({
  imports: [
    // Loads .env and fails fast on a bad environment (Joi, app-config.ts).
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    CoreModule,
    EnginesModule,
    TerminusModule,
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({ limits: { fileSize: cfg.upload.maxBytes, files: 1 } }),
    }),
  ],
  controllers: [DocumentsController, ExtractionsController, CatalogController, HealthController],
  providers: [DocumentsService, CompareService, ExtractionRunner, ExtractionDispatcher],
})
export class AppModule {}
