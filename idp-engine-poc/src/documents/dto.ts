import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { ENGINE_NAMES } from '../engines/engine.port';

const ENGINE_CSV = new RegExp(`^(${ENGINE_NAMES.join('|')})(,(${ENGINE_NAMES.join('|')}))*$`);

/** Text fields of the multipart upload; the file itself arrives via multer (see UPLOAD_BODY_SCHEMA). */
export class UploadDocumentDto {
  @ApiProperty({ example: 'INSURANCE_CARD' })
  @IsString()
  @IsNotEmpty()
  formType!: string;

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
  required: ['file', 'formType'],
  properties: {
    file: { type: 'string', format: 'binary', description: 'PDF, PNG, JPEG or TIFF' },
    formType: { type: 'string', example: 'INSURANCE_CARD' },
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
