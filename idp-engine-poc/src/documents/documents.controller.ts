import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantId } from '../common/tenant.decorator';
import { EngineRegistry } from '../engines/engine-registry';
import { FormRegistry } from '../forms/form-registry';
import { buildJsonSchema } from '../forms/json-schema.builder';
import { CompareService } from './compare.service';
import { DocumentsService } from './documents.service';
import { CompareQueryDto, RunExtractionDto, UPLOAD_BODY_SCHEMA, UploadDocumentDto } from './dto';

const TENANT_HEADER = { name: 'x-tenant-id', required: true, description: 'Tenant id (dev auth)' };

@ApiTags('documents')
@ApiHeader(TENANT_HEADER)
@Controller('v1/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly compareService: CompareService,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Upload any document (PDF, image, Word); auto-detect the form unless formType is given; run engines',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: UPLOAD_BODY_SCHEMA })
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @TenantId() tenantId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadDocumentDto,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'multipart field "file" is required',
      });
    return this.documents.upload(tenantId, file.buffer, dto.formType, dto.engines);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Document with all its extraction runs' })
  get(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.getDocument(tenantId, id);
  }

  @Post(':id/extractions')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Run another engine on an existing document (reuses an identical earlier run)',
  })
  extract(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RunExtractionDto,
  ) {
    return this.documents.extractAgain(tenantId, id, dto.engine, dto.formType);
  }

  @Get(':id/compare')
  @ApiOperation({ summary: 'Field-by-field comparison of the latest run per engine' })
  compare(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CompareQueryDto,
  ) {
    return this.compareService.compare(tenantId, id, q.formType);
  }

  @Get(':id/pages/:n')
  @ApiOperation({ summary: 'Rasterized page PNG (for the review overlay)' })
  async page(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('n', ParseIntPipe) n: number,
  ): Promise<StreamableFile> {
    const png = await this.documents.getPage(tenantId, id, n);
    return new StreamableFile(png, { type: 'image/png', disposition: 'inline' });
  }
}

@ApiTags('extractions')
@ApiHeader(TENANT_HEADER)
@Controller('v1/extractions')
export class ExtractionsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'One extraction run with field values, confidence, bbox and review flags',
  })
  get(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.getExtraction(tenantId, id);
  }
}

@ApiTags('catalog')
@Controller('v1')
export class CatalogController {
  constructor(
    private readonly engines: EngineRegistry,
    private readonly forms: FormRegistry,
  ) {}

  @Get('engines')
  @ApiOperation({ summary: 'Which engines exist and which are enabled by env' })
  listEngines() {
    return this.engines.describe();
  }

  @Get('forms')
  @ApiOperation({ summary: 'Registered form definitions' })
  listForms() {
    return this.forms.list().map((f) => ({
      id: f.id,
      version: f.version,
      title: f.title,
      generic: f.generic ?? false,
      fields: f.fields.length,
      groups: (f.groups ?? []).map((g) => ({
        path: g.path,
        maxRows: g.maxRows,
        columns: g.columns.length,
      })),
      cues: f.cues?.phrases.length ?? 0,
    }));
  }

  @Get('forms/:id')
  @ApiOperation({ summary: 'Form definition plus the JSON Schema sent to schema engines' })
  getForm(@Param('id') id: string) {
    const def = this.forms.get(id);
    return { ...def, jsonSchema: buildJsonSchema(def) };
  }
}
