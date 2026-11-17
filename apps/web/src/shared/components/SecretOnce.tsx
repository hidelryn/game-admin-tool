import { Alert, Typography } from 'antd';

/**
 * 한 번만 보여주는 비밀값 (임시 비밀번호·API 토큰 원문)
 * 서버는 해시만 저장하므로 이 창을 닫으면 다시 볼 수 없다
 */
export function SecretOnce({
  value,
  label,
  warning,
}: {
  value: string;
  label: string;
  warning: string;
}) {
  return (
    <>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="이 창을 닫으면 다시 볼 수 없습니다"
        description={warning}
      />
      <Typography.Text type="secondary">{label}</Typography.Text>
      <Typography.Paragraph
        copyable={{ text: value, tooltips: ['복사', '복사됨'] }}
        code
        style={{ fontSize: 15, wordBreak: 'break-all', marginTop: 4 }}
      >
        {value}
      </Typography.Paragraph>
    </>
  );
}
