import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Col,
  Descriptions,
  Flex,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  DownloadOutlined,
  FileExcelOutlined,
  GiftOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  BULK_GRANT_CONFIRM_THRESHOLD,
  type BulkGrantResult,
  type CurrencyInfo,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { fmtNumber } from '../../shared/format';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { currencyLabel, useCurrencies } from './common';
import { downloadTemplate, validateRows, type ParsedRow } from './bulk-file';
import { readTableFile, type Cell } from '../../shared/file/table-file';

const NO_CURRENCIES: CurrencyInfo[] = [];

/** 서버가 돌려준 문제 행·회원 목록을 한 줄씩 */
function problemLines(details: unknown): string[] | null {
  const d = details as
    | {
        missing?: string[];
        withdrawn?: string[];
        invalidCurrencies?: string[];
        overLimit?: { publicId: string; currencyCode: string; amount: number; limit: number }[];
      }
    | undefined;
  if (d?.overLimit?.length)
    return d.overLimit.map(
      (o) => `${o.publicId}  ${o.currencyCode} ${fmtNumber(o.amount)} (상한 ${fmtNumber(o.limit)})`,
    );
  const list = d?.missing ?? d?.withdrawn ?? d?.invalidCurrencies;
  return list?.length ? list : null;
}

/**
 * 대량 지급 — CSV·엑셀 파일(회원ID·재화·수량·사유)로 행마다 지급
 * - 파일은 브라우저에서만 읽고, 서버에는 검증된 { publicId, currencyCode, amount, reason } 목록만 보낸다
 * - 사유는 행마다 원장·감사 로그에 기록
 * - 전부 성공하거나 전부 실패 (서버 트랜잭션 하나)
 * - 서로 다른 회원 100명 이상이면 빨간 경고로 한 번 더 확인 후 실행 (L3, 웹 전용)
 */
export function BulkGrantPanel() {
  const { modal, message } = App.useApp();
  const run = useSafeAction();
  const queryClient = useQueryClient();
  const currencies = useCurrencies();
  const currencyList = currencies.data ?? NO_CURRENCIES;

  const [fileName, setFileName] = useState<string>();
  const [cells, setCells] = useState<Cell[][]>([]);
  const [reading, setReading] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  const parsed = useMemo(() => validateRows(cells, currencyList), [cells, currencyList]);
  const large = parsed.userCount >= BULK_GRANT_CONFIRM_THRESHOLD;
  const canSubmit =
    parsed.entries.length > 0 && parsed.errorCount === 0 && !parsed.fatal && !!currencies.data;
  const label = (code: string) => currencyLabel(currencies.data, code);

  async function onFile(file: File) {
    setReading(true);
    try {
      setCells(await readTableFile(file));
      setFileName(file.name);
      setErrorsOnly(false);
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '파일을 읽지 못했습니다.');
    } finally {
      setReading(false);
    }
  }

  function clearFile() {
    setCells([]);
    setFileName(undefined);
    setErrorsOnly(false);
  }

  async function submit() {
    const ok = await modal.confirm({
      title: '대량 지급 실행',
      width: 520,
      content: (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="파일">{fileName}</Descriptions.Item>
          <Descriptions.Item label="대상">
            {fmtNumber(parsed.userCount)}명 · {fmtNumber(parsed.entries.length)}건
          </Descriptions.Item>
          <Descriptions.Item label="재화별 총량">
            {parsed.totals.map((t) => (
              <div key={t.currencyCode}>
                {label(t.currencyCode)} <b>{fmtNumber(t.amount)}</b>
              </div>
            ))}
          </Descriptions.Item>
          <Descriptions.Item label="처리">
            {large ? '다음 단계에서 한 번 더 확인 후 실행' : '즉시 실행'}
          </Descriptions.Item>
        </Descriptions>
      ),
      okText: large ? '다음' : '지급',
      okButtonProps: { danger: !large },
    });
    if (!ok) return;

    setLoading(true);
    const res = await run<BulkGrantResult>({
      request: ({ idempotencyKey, confirmationToken }) =>
        api.post(
          '/currencies/bulk-grant',
          { entries: parsed.entries, ...(confirmationToken ? { confirmationToken } : {}) },
          { idempotencyKey },
        ),
      confirmTitle: '대량 지급 최종 확인',
      onError: (err) => {
        const lines = problemLines(err.details);
        if (!lines) return false;
        modal.error({
          title: err.message,
          width: 520,
          content: (
            <>
              <Typography.Paragraph>
                아무에게도 지급되지 않았습니다. 아래 항목을 파일에서 고치거나 빼고 다시 올려 주세요.
              </Typography.Paragraph>
              <Typography.Paragraph code copyable style={{ whiteSpace: 'pre-wrap' }}>
                {lines.join('\n')}
              </Typography.Paragraph>
              {lines.length >= 20 && (
                <Typography.Text type="secondary">처음 20건만 표시합니다.</Typography.Text>
              )}
            </>
          ),
        });
        return true;
      },
    });
    setLoading(false);
    if (!res) return;

    if (res.status === 200) {
      const r = res.data;
      modal.success({
        title: '지급했습니다',
        content: (
          <>
            {fmtNumber(r.userCount)}명에게 {fmtNumber(r.count)}건 지급했습니다.
            {r.totals.map((t) => (
              <div key={t.currencyCode}>
                {label(t.currencyCode)} {fmtNumber(t.amount)}
              </div>
            ))}
          </>
        ),
      });
      void queryClient.invalidateQueries({ queryKey: ['currency-transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['user'] });
    }
    clearFile();
  }

  const preview: ParsedRow[] = errorsOnly ? parsed.rows.filter((r) => r.error) : parsed.rows;

  return (
    <>
      <Row gutter={[24, 16]}>
        <Col xs={24} lg={14}>
          <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
            <Typography.Text strong>지급 파일</Typography.Text>
            <Button size="small" type="link" icon={<DownloadOutlined />} onClick={downloadTemplate}>
              양식 받기
            </Button>
          </Flex>
          {fileName ? (
            <Flex
              align="center"
              gap={8}
              style={{ padding: '12px 16px', border: '1px solid #f0f0f0', borderRadius: 8 }}
            >
              <FileExcelOutlined style={{ fontSize: 20, color: '#1baf7a' }} />
              <Typography.Text strong>{fileName}</Typography.Text>
              <Typography.Text type="secondary">
                {fmtNumber(parsed.rows.length)}행{parsed.hasHeader ? ' (머리글 제외)' : ''}
              </Typography.Text>
              <Button size="small" style={{ marginLeft: 'auto' }} onClick={clearFile}>
                다른 파일
              </Button>
            </Flex>
          ) : (
            <Upload.Dragger
              accept=".csv,.xlsx"
              multiple={false}
              showUploadList={false}
              disabled={reading}
              beforeUpload={(file) => {
                void onFile(file);
                return false; // 자동 업로드 막기 — 파일은 서버로 보내지 않는다
              }}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">
                {reading ? '읽는 중…' : 'CSV 또는 엑셀(.xlsx) 파일을 끌어다 놓거나 클릭하세요'}
              </p>
              <p className="ant-upload-hint">
                열: 회원ID · 재화 · 수량 · 사유 (재화는 코드나 이름, 사유 5~200자) · 최대 1,000명,
                2MB
              </p>
            </Upload.Dragger>
          )}
          <Button
            type="primary"
            icon={<GiftOutlined />}
            loading={loading}
            onClick={submit}
            disabled={!canSubmit}
            style={{ marginTop: 16 }}
          >
            지급
          </Button>
        </Col>

        <Col xs={24} lg={10}>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic title="대상 회원" value={parsed.userCount} suffix="명" />
            </Col>
            <Col span={8}>
              <Statistic title="지급 건수" value={parsed.entries.length} suffix="건" />
            </Col>
            <Col span={8}>
              <Statistic
                title="오류"
                value={parsed.errorCount}
                suffix="행"
                valueStyle={parsed.errorCount ? { color: '#cf1322' } : undefined}
              />
            </Col>
          </Row>
          {parsed.totals.length > 0 && (
            <Flex wrap gap={8} style={{ marginBottom: 16 }}>
              {parsed.totals.map((t) => (
                <Tag key={t.currencyCode} style={{ padding: '4px 10px', fontSize: 13 }}>
                  {label(t.currencyCode)} <b>{fmtNumber(t.amount)}</b>
                </Tag>
              ))}
            </Flex>
          )}
          <Space direction="vertical" style={{ width: '100%' }}>
            {parsed.fatal && <Alert type="error" showIcon message={parsed.fatal} />}
            {parsed.errorCount > 0 && (
              <Alert
                type="error"
                showIcon
                message={`오류 ${fmtNumber(parsed.errorCount)}행을 고쳐야 지급할 수 있습니다`}
                description="아래 미리보기에서 행 번호와 이유를 확인하고, 파일을 고쳐 다시 올려 주세요."
              />
            )}
            {large && !parsed.fatal && (
              <Alert
                type="error"
                showIcon
                message={`${fmtNumber(BULK_GRANT_CONFIRM_THRESHOLD)}명 이상 대량 지급입니다`}
                description="지급 전에 대상 수·재화별 총량을 빨간 경고 화면으로 한 번 더 확인합니다. MCP(API 토큰)로는 실행할 수 없습니다."
              />
            )}
            <Alert
              type="warning"
              showIcon
              message="전부 성공하거나 전부 실패합니다"
              description="없는 회원이나 탈퇴한 회원이 한 명이라도 있으면 아무에게도 지급되지 않습니다. 재화별 1인당 상한은 '재화 정보' 탭에서 볼 수 있습니다."
            />
          </Space>
        </Col>
      </Row>

      {parsed.rows.length > 0 && (
        <>
          <Flex justify="space-between" align="center" style={{ margin: '24px 0 8px' }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              미리보기
            </Typography.Title>
            <Space>
              <Typography.Text type="secondary">오류만 보기</Typography.Text>
              <Switch
                size="small"
                checked={errorsOnly}
                onChange={setErrorsOnly}
                disabled={!parsed.errorCount}
              />
            </Space>
          </Flex>
          <Table<ParsedRow>
            rowKey="row"
            size="small"
            dataSource={preview}
            scroll={{ x: 900 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              showTotal: (n) => `${fmtNumber(n)}행`,
            }}
            columns={[
              { title: '행', dataIndex: 'row', width: 60 },
              {
                title: '회원 ID',
                dataIndex: 'publicId',
                width: 130,
                render: (v: string) =>
                  v || <Typography.Text type="secondary">(빈칸)</Typography.Text>,
              },
              {
                title: '재화',
                dataIndex: 'currencyCode',
                width: 150,
                render: (c: string) =>
                  c ? label(c) : <Typography.Text type="secondary">(빈칸)</Typography.Text>,
              },
              {
                title: '수량',
                dataIndex: 'amount',
                align: 'right',
                width: 110,
                render: (v: number | null) => fmtNumber(v),
              },
              {
                title: '사유',
                dataIndex: 'reason',
                ellipsis: true,
                render: (v: string) =>
                  v || <Typography.Text type="secondary">(빈칸)</Typography.Text>,
              },
              {
                title: '상태',
                dataIndex: 'error',
                width: 220,
                render: (e?: string) =>
                  e ? <Tag color="error">{e}</Tag> : <Tag color="success">정상</Tag>,
              },
            ]}
          />
        </>
      )}
    </>
  );
}
