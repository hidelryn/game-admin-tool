import { Form, Input } from 'antd';

/** 변경 작업 사유 (서버 규칙과 동일: 5~200자) */
export function ReasonField({
  name = 'reason',
  label = '사유',
}: {
  name?: string;
  label?: string;
}) {
  return (
    <Form.Item
      name={name}
      label={label}
      rules={[
        { required: true, message: '사유를 입력하세요.' },
        { min: 5, message: '5자 이상 입력하세요.' },
        { max: 200, message: '200자 이하로 입력하세요.' },
      ]}
    >
      <Input.TextArea rows={3} showCount maxLength={200} placeholder="감사 로그에 기록됩니다" />
    </Form.Item>
  );
}
