import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { ENGINE_NAMES } from '../engines/engine.port';

const ENGINE_CSV = new RegExp(`^(${ENGINE_NAMES.join('|')})(,(${ENGINE_NAMES.join('|')}))*$`);

/** Text fields of the multipart upload; the file itself arrives via multer (see UPLOAD_BODY_SCHEMA). */
export class UploadDocumentDto {
  @ApiPropertyOptional({
    example: 'CMS1500',
    description: 'Skip auto-classification. Omit to detect the form from the document text',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  formType?: string;

  @ApiPropertyOptional({
    example: 'textract,vlmrun,meibel',
    description: 'Comma-separated engines to run. Default: ENGINE_DEFAULT',
  })
  @IsOptional()
  @Matches(ENGINE_CSV, { message: `engines must be a comma list of ${ENGINE_NAMES.join('|')}` })
  engines?: string;
}

export const UPLOAD_BODY_SCHEMA = {
  type: 'object',
  required: ['file'],
  properties: {
    file: {
      type: 'string',
      format: 'binary',
      description: 'PDF, PNG, JPEG, TIFF or DOCX',
    },
    formType: {
      type: 'string',
      example: 'CMS1500',
      description: 'Optional. Omit to auto-detect (falls back to GENERIC)',
    },
    engines: {
      type: 'string',
      example: 'textract,vlmrun,meibel',
      description: 'Default: ENGINE_DEFAULT',
    },
  },
};

export class RunExtractionDto {
  @ApiProperty({ enum: ENGINE_NAMES })
  @IsIn(ENGINE_NAMES)
  engine!: string;

  @ApiPropertyOptional({ description: 'Defaults to the document formType' })
  @IsOptional()
  @IsString()
  formType?: string;
}

export class CompareQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  formType?: string;
}
