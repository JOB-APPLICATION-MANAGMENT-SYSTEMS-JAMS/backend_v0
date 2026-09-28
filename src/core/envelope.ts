import type { Response } from "express";

/**
 * The envelope (§12.1 / §33.1) — identical to the reference codebase:
 * success → { status, status_code, message, data }
 * failure → { status: "failure", status_code, message, error: { code, detail, retry_after?, fields? } }
 */
export interface Pagination {
  page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
}

export const pagination = (page: number, pageSize: number, totalCount: number): Pagination => ({
  page,
  page_size: pageSize,
  total_count: totalCount,
  total_pages: Math.max(1, Math.ceil(totalCount / pageSize)),
});

export function ok<T>(res: Response, message: string, data: T, status = 200) {
  return res.status(status).json({ status: "success", status_code: status, message, data });
}

export function fail(
  res: Response,
  status: number,
  message: string,
  error?: { code?: string; detail?: string | null; retry_after?: number | null; fields?: any }
) {
  return res.status(status).json({
    status: "failure",
    status_code: status,
    message,
    error: { code: error?.code ?? "ERROR", detail: error?.detail ?? null, retry_after: error?.retry_after ?? null, fields: error?.fields ?? null },
  });
}
