import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export const STORAGE = Symbol('STORAGE');

/** Object storage seam. Local disk for dev, S3 (SSE-KMS) for anything real. */
export interface StoragePort {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Key layout from plan 02 §6, under STORAGE_PREFIX. Keys carry ids only, never file names. */
export const storageKeys = {
  original: (t: string, d: string, ext: string) => `t/${t}/d/${d}/original.${ext}`,
  /** Converted PDF (Word -> PDF); engines receive this instead of the original. */
  normalized: (t: string, d: string) => `t/${t}/d/${d}/normalized.pdf`,
  page: (t: string, d: string, n: number) => `t/${t}/d/${d}/pages/${n}.png`,
  raw: (t: string, d: string, engine: string, extractionId: string) =>
    `t/${t}/d/${d}/engine/${engine}/${extractionId}.json.gz`,
};

export class LocalStorage implements StoragePort {
  private readonly root: string;

  constructor(dir: string, prefix: string) {
    this.root = resolve(dir, prefix);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error('STORAGE_KEY_OUTSIDE_ROOT');
    return path;
  }
}

export class S3Storage implements StoragePort {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly kmsKeyId?: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'aws:kms',
        ...(this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
    );
    if (!res.Body) throw new Error('STORAGE_EMPTY_BODY');
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
  }
}
