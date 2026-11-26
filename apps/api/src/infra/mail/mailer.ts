import nodemailer from 'nodemailer';
import type { Env } from '../../config/env.js';

/**
 * 메일 발송 어댑터 (docs/email.md)
 * - SMTP 설정(SMTP_HOST·SMTP_USER·SMTP_PASS·MAIL_FROM)이 있으면 실제 발송 (예: Brevo 무료 SMTP)
 * - 없으면 real=false → 모든 발송이 "가상 발송"으로 기록만 남는다
 * - 테스트는 보낸 메일을 모으는 가짜 메일러를 넣는다
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** 실제로 메일 서버에 보내는지 */
  readonly real: boolean;
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
}

export function createMailer(env: Env): Mailer {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.MAIL_FROM) {
    return {
      real: false,
      async send() {
        throw new Error('SMTP 가 설정되지 않았습니다.');
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    real: true,
    async send(mail) {
      const info = await transport.sendMail({ from: env.MAIL_FROM, ...mail });
      return { messageId: String(info.messageId ?? '') };
    },
  };
}

/** 테스트용 — 보낸 메일을 모아 두고, failFor 에 든 주소는 실패시킨다 */
export function createFakeMailer(opts: { failFor?: string[] } = {}) {
  const sent: OutgoingMail[] = [];
  const mailer: Mailer & { sent: OutgoingMail[] } = {
    real: true,
    sent,
    async send(mail) {
      if (opts.failFor?.includes(mail.to)) throw new Error('fake smtp failure');
      sent.push(mail);
      return { messageId: `<fake-${sent.length}@test>` };
    },
  };
  return mailer;
}
