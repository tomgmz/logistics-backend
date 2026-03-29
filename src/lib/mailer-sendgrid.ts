import sgMail from '@sendgrid/mail'

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const FROM_ADDRESS = process.env.SENDGRID_FROM_EMAIL || process.env.MAIL_FROM || 'noreply@example.com'
const APP_NAME = process.env.APP_NAME || 'Logistics'

if (!SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY is not set. Email functionality will not work.')
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

  const name = firstName ?? 'there'

  try {
    const message = {
      to,
      from: {
        email: FROM_ADDRESS,
        name: APP_NAME,
      },
      subject: `Your ${APP_NAME} login code`,
      html: generateOtpEmailHtml(name, code),
      text: generateOtpEmailText(name, code),
      // Tracking settings (optional - disable for privacy)
      trackingSettings: {
        clickTracking: { enable: false },
        openTracking: { enable: false },
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
    
    // Check for specific SendGrid errors
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
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
              <!-- Header -->
              <tr>
                <td style="padding:40px 40px 20px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:24px;color:#1a1a1a;font-weight:600;">
                    Your login code
                  </h1>
                </td>
              </tr>
              
              <!-- Body -->
              <tr>
                <td style="padding:0 40px;">
                  <p style="margin:0 0 20px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.5;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 30px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.5;">
                    Use the code below to sign in to <strong>${APP_NAME}</strong>. This code expires in <strong>5 minutes</strong>.
                  </p>
                  
                  <!-- OTP Code Box -->
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center" style="padding:30px 0;">
                        <div style="display:inline-block;background-color:#f4f4f5;border-radius:12px;padding:30px 50px;">
                          <span style="font-family:'Courier New',monospace;font-size:40px;font-weight:bold;letter-spacing:12px;color:#1a1a1a;">
                            ${code}
                          </span>
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
              <!-- Footer -->
              <tr>
                <td style="padding:20px 40px 40px 40px;">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#666666;line-height:1.5;">
                    If you didn't request this code, you can safely ignore this email. Never share this code with anyone.
                  </p>
                </td>
              </tr>
              
              <!-- Bottom Bar -->
              <tr>
                <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    © ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
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
  return `
Hi ${name},

Your ${APP_NAME} login code is:

${code}

This code expires in 5 minutes.

If you didn't request this code, you can safely ignore this email.
Never share this code with anyone.

---
© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
  `.trim()
}