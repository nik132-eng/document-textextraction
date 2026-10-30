import { Global, Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { APP_CONFIG, loadAppConfig, type AppConfig } from './config/app-config';
import { createRootLogger, PinoNestLogger } from './common/logger';
import { FormRegistry } from './forms/form-registry';
import { PrismaService } from './prisma/prisma.service';
import { RasterizerService } from './rasterizer/rasterizer.service';
import { LocalStorage, S3Storage, STORAGE, type StoragePort } from './storage/storage';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadAppConfig(process.env) },
    {
      provide: PinoNestLogger,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new PinoNestLogger(createRootLogger(cfg.logLevel)),
    },
    {
      provide: STORAGE,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig): StoragePort =>
        cfg.storage.driver === 's3'
          ? new S3Storage(
              new S3Client({ region: cfg.aws.region }),
              cfg.storage.bucket!,
              cfg.storage.prefix,
              cfg.storage.kmsKeyId,
            )
          : new LocalStorage(cfg.storage.dir, cfg.storage.prefix),
    },
    PrismaService,
    FormRegistry,
    RasterizerService,
  ],
  exports: [APP_CONFIG, PinoNestLogger, STORAGE, PrismaService, FormRegistry, RasterizerService],
})
export class CoreModule {}
