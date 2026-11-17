import { z } from 'zod';
import { Channel } from '../permissions.js';
import { cursorQuerySchema, dateSchema } from './common.js';

export const listAuditLogsQuerySchema = cursorQuerySchema.extend({
  adminId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(50).optional(),
  targetType: z.string().trim().max(30).optional(),
  targetId: z.string().trim().max(64).optional(),
  channel: z.nativeEnum(Channel).optional(),
  result: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export interface AuditLogItem {
  id: number;
  admin: { id: number; name: string } | null;
  apiTokenId: number | null;
  channel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  result: string;
  errorCode: string | null;
  requestId: string | null;
  ip: string | null;
  createdAt: string;
}
