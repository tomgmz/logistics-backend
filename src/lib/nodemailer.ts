import nodemailer from 'nodemailer'

const APP_NAME          = process.env.APP_NAME             || 'Logistics'
const PHYSICAL_ADDRESS  = process.env.APP_PHYSICAL_ADDRESS || 'Blk. 6 Lot 8 Lynville Enclave, Mamatid, City of Cabuyao, Laguna'
const APP_SUPPORT_EMAIL = process.env.APP_SUPPORT_EMAIL    || process.env.GMAIL_USER
const FROM_ADDRESS      = process.env.GMAIL_USER!

// Railway cannot reach Gmail over IPv6 — force IPv4
const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   465,
  secure: true,          // SSL on port 465
  pool:   true,          // reuse connections
  family: 4,             // force IPv4
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
})

transporter.verify((error) => {
  if (error) {
    console.error('[mailer] SMTP connection failed:', error.message)
  } else {
    console.log('[mailer] SMTP connection ready')
  }
})

export async function sendOtpEmail(
  to: string,
  code: string,
  firstName?: string | null
): Promise<void> {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('Gmail is not configured. Please set GMAIL_USER and GMAIL_APP_PASSWORD.')
  }

  const name = firstName ?? 'there'

  await transporter.sendMail({
    from:    `"${APP_NAME}" <${FROM_ADDRESS}>`,
    to,
    subject: `${code} is your ${APP_NAME} verification code`,
    html:    generateOtpEmailHtml(name, code),
    text:    generateOtpEmailText(name, code),
  })

  console.log(`[mailer] OTP sent to ${to}`)
}

function generateOtpEmailHtml(name: string, code: string): string {
  const year = new Date().getFullYear()

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your ${APP_NAME} login code</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your one-time login code for ${APP_NAME} — expires in 5 minutes.
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

              <tr>
                <td style="padding:40px 40px 20px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#1a1a1a;font-weight:700;">
                    ${APP_NAME}
                  </h1>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px;">
                  <hr style="border:none;border-top:1px solid #eeeeee;margin:0;">
                </td>
              </tr>

              <tr>
                <td style="padding:30px 40px 0 40px;">
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 24px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Here is your one-time login code for <strong>${APP_NAME}</strong>.
                    It expires in <strong>5 minutes</strong>.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="padding:20px 0;">
                        <table cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td style="background-color:#f4f4f5;border-radius:12px;padding:24px 48px;text-align:center;">
                              <span style="font-family:'Courier New',Courier,monospace;font-size:40px;font-weight:bold;letter-spacing:12px;color:#1a1a1a;">
                                ${code}
                              </span>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#fff8f0;border-left:4px solid #f59e0b;border-radius:4px;padding:14px 16px;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.5;">
                          <strong>Never share this code.</strong> ${APP_NAME} will never ask for your code by phone or email.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#666666;line-height:1.5;">
                    If you did not request this code, you can safely ignore this email.
                    Contact us at
                    <a href="mailto:${APP_SUPPORT_EMAIL}" style="color:#4f46e5;text-decoration:none;">${APP_SUPPORT_EMAIL}</a>
                    if you have concerns.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    © ${year} ${APP_NAME}. All rights reserved.
                  </p>
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    ${PHYSICAL_ADDRESS}
                  </p>
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    This is a transactional email sent because a login was requested for your account.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>

    </body>
    </html>
  `
}

function generateOtpEmailText(name: string, code: string): string {
  const year = new Date().getFullYear()

  return `
Hi ${name},

Your ${APP_NAME} login code is:

${code}

This code expires in 5 minutes.

NEVER share this code with anyone. ${APP_NAME} will never ask for your code by phone or email.

If you did not request this code, you can safely ignore this email.
For concerns, contact us at ${APP_SUPPORT_EMAIL}.

---
© ${year} ${APP_NAME}. All rights reserved.
${PHYSICAL_ADDRESS}
  `.trim()
}