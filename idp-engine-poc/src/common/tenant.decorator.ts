import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

const TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Dev auth: the tenant comes from the `x-tenant-id` header (plan 00 §8.3 AuthPort default).
 * In the host project, replace this with an adapter over the host's own guard / current-user decorator.
 */
export const TenantId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const raw = req.headers['x-tenant-id'];
  const tenant = Array.isArray(raw) ? raw[0] : raw;
  if (!tenant || !TENANT_RE.test(tenant)) {
    throw new BadRequestException({
      code: 'TENANT_REQUIRED',
      message: 'x-tenant-id header is required',
    });
  }
  return tenant;
});
