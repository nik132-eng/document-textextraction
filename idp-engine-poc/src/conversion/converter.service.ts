import { Injectable } from '@nestjs/common';
import { MIME, type NormalizedMime, type SupportedMime } from '../common/util';
import { docxToLines } from './docx-text';
import { linesToPdf } from './text-pdf';

export type ConversionKind = 'none' | 'docx-text';

export interface NormalizedDocument {
  bytes: Buffer;
  mimeType: NormalizedMime;
  conversion: ConversionKind;
}

/**
 * Any accepted upload -> PDF or image, so the rest of the pipeline only knows two shapes.
 *   pdf / png / jpeg / tiff -> unchanged
 *   docx                    -> text PDF built in pure JS (paragraphs, tables, checkboxes; layout not kept)
 * No external converter and no system dependency.
 */
@Injectable()
export class ConverterService {
  normalize(bytes: Buffer, mime: SupportedMime): Promise<NormalizedDocument> {
    if (mime === MIME.docx) {
      return Promise.resolve({
        bytes: linesToPdf(docxToLines(bytes)),
        mimeType: MIME.pdf,
        conversion: 'docx-text',
      });
    }
    return Promise.resolve({ bytes, mimeType: mime, conversion: 'none' });
  }
}
