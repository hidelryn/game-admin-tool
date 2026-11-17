import type { ReactNode } from 'react';
import { Alert, App, Typography } from 'antd';
import type { ConfirmationRequiredDetails, DangerPreview } from '@game-admin/shared';
import { ApiError, type ApiResult } from '../api/client';
import { DangerPreviewView, isDangerPreview } from './DangerPreview';

interface SafeActionOptions<T> {
  /** 실제 요청. idempotencyKey 는 재시도·확인 2차 호출까지 같은 값 */
  request(extra: { idempotencyKey: string; confirmationToken?: string }): Promise<ApiResult<T>>;
  /** 확인 토큰이 필요할 때(L2) 미리보기를 어떻게 보여줄지. L3 미리보기는 지정하지 않아도 빨간 경고 화면 */
  renderPreview?(preview: unknown): ReactNode;
  confirmTitle?: string;
  successMessage?: string;
  /** 에러를 화면에서 직접 보여주고 싶을 때. true 를 돌려주면 기본 에러 메시지를 띄우지 않는다 */
  onError?(err: ApiError): boolean;
}

/**
 * 변경 작업 공통 흐름 (architecture.md 4.4, 6장)
 * 1. Idempotency-Key 를 한 번 만들어 1차·2차 요청에 같이 사용 (더블 클릭·재시도 안전)
 * 2. 422 CONFIRMATION_REQUIRED → 미리보기 모달 → 확인 시 confirmationToken 을 넣어 재요청
 *    - L3(대량 지급·전체 우편·랭킹 초기화/복원/보상): 빨간 경고 화면으로 한 번 더 확인
 * 3. 그 외 에러는 서버 메시지를 그대로 표시
 * @returns 성공 시 응답 data, 취소·실패 시 null
 */
export function useSafeAction() {
  const { modal, message } = App.useApp();

  return async function run<T>(
    opts: SafeActionOptions<T>,
  ): Promise<{ data: T; status: number } | null> {
    const idempotencyKey = crypto.randomUUID();

    const done = (res: ApiResult<T>) => {
      if (opts.successMessage) void message.success(opts.successMessage);
      return { data: res.data, status: res.status };
    };

    try {
      return done(await opts.request({ idempotencyKey }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFIRMATION_REQUIRED') {
        const details = err.details as ConfirmationRequiredDetails;
        const danger = isDangerPreview(details.preview);
        const confirmed = await modal.confirm({
          title: danger ? (
            <Typography.Text type="danger" strong>
              {opts.confirmTitle ?? '대규모 작업 실행 확인'}
            </Typography.Text>
          ) : (
            (opts.confirmTitle ?? '실행 전 확인')
          ),
          width: danger ? 560 : 480,
          content: (
            <>
              {danger ? (
                <DangerPreviewView p={details.preview as DangerPreview} />
              ) : (
                <>
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="아직 실행되지 않았습니다. 아래 내용을 확인하세요."
                  />
                  {opts.renderPreview ? (
                    opts.renderPreview(details.preview)
                  ) : (
                    <pre>{JSON.stringify(details.preview, null, 2)}</pre>
                  )}
                </>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                확인 유효 시간: 5분
              </Typography.Text>
            </>
          ),
          okText: danger ? '확인했습니다, 실행' : '실행',
          okButtonProps: { danger: true },
          cancelText: '취소',
        });
        if (!confirmed) return null;
        try {
          return done(
            await opts.request({ idempotencyKey, confirmationToken: details.confirmationToken }),
          );
        } catch (second) {
          showError(second, opts.onError);
          return null;
        }
      }
      showError(err, opts.onError);
      return null;
    }
  };

  function showError(err: unknown, onError?: (err: ApiError) => boolean) {
    if (err instanceof ApiError) {
      if (onError?.(err)) return;
      void message.error(err.message);
    } else {
      void message.error('요청 중 오류가 발생했습니다.');
    }
  }
}
