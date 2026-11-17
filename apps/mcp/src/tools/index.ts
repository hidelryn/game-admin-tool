import type { ToolDef } from './define.js';
import { getUserDetail, searchUser, suspendUser, unsuspendUser } from './users.js';
import {
  bulkGrantCurrency,
  deductCurrency,
  getUserCurrency,
  grantCurrency,
  listCurrencies,
} from './currencies.js';
import { getRanking, listRankingSeasons } from './rankings.js';
import { createNotice, getMaintenanceStatus, listNotices, listSchedules } from './live-ops.js';
import { getOperationLogs, sendMail } from './mails-audit.js';

/** 전체 Tool (docs/mcp-tools.md 2장). 실제 노출은 토큰 권한으로 거른다 */
export const ALL_TOOLS = [
  // 조회
  searchUser,
  getUserDetail,
  getUserCurrency,
  listCurrencies,
  getRanking,
  listRankingSeasons,
  listSchedules,
  getMaintenanceStatus,
  listNotices,
  getOperationLogs,
  // 변경
  grantCurrency,
  deductCurrency,
  bulkGrantCurrency,
  sendMail,
  suspendUser,
  unsuspendUser,
  createNotice,
] as unknown as readonly ToolDef[];

export const visibleTools = (perms: ReadonlySet<string>, tools = ALL_TOOLS) =>
  tools.filter((t) => t.visible(perms));
