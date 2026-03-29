import sgMail from '@sendgrid/mail'

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const FROM_ADDRESS = process.env.SENDGRID_FROM_EMAIL || process.env.MAIL_FROM
const APP_NAME = process.env.APP_NAME || 'Logistics'
const PHYSICAL_ADDRESS = process.env.APP_PHYSICAL_ADDRESS || 'Blk. 6 Lot 8 Lynville Enclave, Mamatid, City of Cabuyao, Laguna'
const APP_SUPPORT_EMAIL = process.env.APP_SUPPORT_EMAIL || FROM_ADDRESS

if (!SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY is not set. Email functionality will not work.')
} else if (!FROM_ADDRESS) {
  console.error('SENDGRID_FROM_EMAIL is not set. Email functionality will not work.')
} else {
  sgMail.setApiKey(SENDGRID_API_KEY)
  console.log('SendGrid initialized')
}

/**
 * Send OTP verification code via email
 * @param to - Recipient email address
 * @param code - 6-digit OTP code
 * @param firstName - Recipient's first name (optional)
 */
export async function sendOtpEmail(
  to: string,
  code: string,
  firstName?: string | null
): Promise<void> {
  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid is not configured. Please set SENDGRID_API_KEY environment variable.')
  }

  if (!FROM_ADDRESS) {
    throw new Error('Sender email is not configured. Please set SENDGRID_FROM_EMAIL environment variable.')
  }

  const name = firstName ?? 'there'

  try {
    const message = {
      to,
      from: {
        email: FROM_ADDRESS,
        name: APP_NAME,
      },
      // Clear, specific subject — avoids generic/phishy patterns
      subject: `${code} is your ${APP_NAME} verification code`,
      html: generateOtpEmailHtml(name, code),
      text: generateOtpEmailText(name, code),
      // Required headers for better deliverability
      headers: {
        'X-Priority': '1',
        'X-Mailer': APP_NAME,
      },
      // Disable tracking — improves trust score and privacy
      trackingSettings: {
        clickTracking: { enable: false },
        openTracking: { enable: false },
      },
      // Mail settings
      mailSettings: {
        bypassListManagement: {
          enable: true, // OTP emails are transactional, bypass unsubscribe lists
        },
      },
    }

    await sgMail.send(message)
    console.log(`OTP email sent to ${to}`)
  } catch (error: any) {
    console.error('SendGrid error:', {
      message: error.message,
      code: error.code,
      response: error.response?.body,
    })

    if (error.code === 403) {
      throw new Error('Email service authentication failed. Please check SENDGRID_API_KEY.')
    }
    if (error.response?.body?.errors) {
      const errorMsg = error.response.body.errors[0]?.message || 'Unknown error'
      throw new Error(`Failed to send verification code: ${errorMsg}`)
    }

    throw new Error('Failed to send verification code. Please try again later.')
  }
}

function generateOtpEmailHtml(name: string, code: string): string {
  const year = new Date().getFullYear()

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="x-apple-disable-message-reformatting">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <title>Your ${APP_NAME} login code</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">

      <!-- Preheader text (hidden, shows in inbox preview) -->
      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your one-time login code for ${APP_NAME} — expires in 5 minutes.
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

              <!-- Header -->
              <tr>
                <td style="padding:40px 40px 20px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#1a1a1a;font-weight:700;">
                    ${APP_NAME}
                  </h1>
                </td>
              </tr>

              <!-- Divider -->
              <tr>
                <td style="padding:0 40px;">
                  <hr style="border:none;border-top:1px solid #eeeeee;margin:0;">
                </td>
              </tr>

              <!-- Body -->
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

              <!-- OTP Code Box -->
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

              <!-- Warning -->
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

              <!-- Didn't request note -->
              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#666666;line-height:1.5;">
                    If you did not request this code, you can safely ignore this email.
                    Someone may have entered your email address by mistake.
                    Contact us at
                    <a href="mailto:${APP_SUPPORT_EMAIL}" style="color:#4f46e5;text-decoration:none;">${APP_SUPPORT_EMAIL}</a>
                    if you have concerns.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;line-height:1.5;">
                    © ${year} ${APP_NAME}. All rights reserved.
                  </p>
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;line-height:1.5;">
                    ${PHYSICAL_ADDRESS}
                  </p>
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;line-height:1.5;">
                    This is a transactional email sent because a login was requested for your account.
                    You cannot unsubscribe from security emails.
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

/**
 * Generate plain text email (fallback for non-HTML clients)
 */
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

This is a transactional security email. You cannot unsubscribe from login verification emails.
  `.trim()
}