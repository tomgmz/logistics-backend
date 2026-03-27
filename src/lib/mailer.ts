import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM_ADDRESS = process.env.MAIL_FROM ?? 'no-reply@yourdomain.com'
const APP_NAME     = process.env.APP_NAME  ?? 'Logistics'

export async function sendOtpEmail(to: string, code: string, firstName?: string | null): Promise<void> {
  const name = firstName ?? 'there'

  await resend.emails.send({
    from:    FROM_ADDRESS,
    to,
    subject: `Your ${APP_NAME} login code`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#1a1a1a;">Your login code</h2>
        <p>Hi ${name},</p>
        <p>Use the code below to sign in to <strong>${APP_NAME}</strong>. It expires in <strong>10 minutes</strong>.</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;text-align:center;
                    padding:24px;background:#f4f4f5;border-radius:8px;margin:24px 0;">
          ${code}
        </div>
        <p style="color:#666;font-size:13px;">
          If you didn't request this, you can safely ignore this email.
          Never share this code with anyone.
        </p>
      </div>
    `,
  })
}