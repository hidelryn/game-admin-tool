import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const HEADER = 'x-request-id';
// 외부에서 들어온 값은 형식을 검증한 뒤에만 신뢰 (로그 인젝션 방지)
const SAFE_ID = /^[A-Za-z0-9-_]{8,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(HEADER);
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};
