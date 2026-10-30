import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  ENGINE_NAMES,
  EXTRACTION_ENGINES,
  type EngineName,
  type ExtractionEngine,
} from './engine.port';
import { TextractEngine } from './textract/textract.engine';

@Injectable()
export class EngineRegistry {
  private readonly byName: Map<EngineName, ExtractionEngine>;

  constructor(
    @Inject(EXTRACTION_ENGINES) engines: ExtractionEngine[],
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.byName = new Map(engines.map((e) => [e.name, e]));
  }

  get defaultName(): EngineName {
    return this.cfg.engines.default;
  }

  get(name: string): ExtractionEngine {
    const engine = this.byName.get(name as EngineName);
    if (!engine) {
      throw new BadRequestException({
        code: 'ENGINE_DISABLED',
        message: `Engine "${name}" is not enabled. Enabled: ${[...this.byName.keys()].join(', ')}`,
      });
    }
    return engine;
  }

  /**
   * OCR for classifying pages that have no text layer (scans, photos), or null when
   * CLASSIFY_OCR=none. Boot validation guarantees textract is enabled when it is 'textract'.
   */
  pageOcr(): ((png: Buffer) => Promise<string>) | null {
    if (this.cfg.classifyOcr !== 'textract') return null;
    const engine = this.byName.get('textract');
    return engine instanceof TextractEngine ? (png) => engine.detectText(png) : null;
  }

  /** Parses "textract,vlmrun" (or undefined -> default) and checks each is enabled. */
  resolve(csv?: string): EngineName[] {
    const names = csv
      ? [
          ...new Set(
            csv
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ]
      : [this.defaultName];
    return names.map((n) => this.get(n).name);
  }

  describe() {
    return ENGINE_NAMES.map((name) => ({
      name,
      enabled: this.byName.has(name),
      default: name === this.defaultName,
    }));
  }
}
