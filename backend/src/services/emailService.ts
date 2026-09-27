import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

let transporterPromise: Promise<Transporter> | null = null;

/**
 * Lazily creates a nodemailer transporter against Ethereal Email (fake SMTP).
 * If ETHEREAL_USER/PASS aren't set, a fresh disposable test account is
 * created automatically on first use — convenient for local dev/demo, but
 * for a stable demo across restarts you should set them explicitly in .env
 * (print them once from a throwaway run, see README).
 */
function getTransporter(): Promise<Transporter> {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      let user = env.etherealUser;
      let pass = env.etherealPass;
      if (!user || !pass) {
        const testAccount = await nodemailer.createTestAccount();
        user = testAccount.user;
        pass = testAccount.pass;
        console.log(
          `[emailService] No ETHEREAL_USER/PASS set — created a temporary Ethereal account:\n` +
            `  user: ${user}\n  pass: ${pass}\n` +
            `Add these to your .env to reuse the same inbox across restarts.`
        );
      }
      return nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false,
        auth: { user, pass },
      });
    })();
  }
  return transporterPromise;
}

export interface SendResult {
  previewUrl: string | false;
  messageId: string;
}

export async function sendEmail(params: {
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<SendResult> {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: params.from,
    to: params.to,
    subject: params.subject,
    text: params.text,
  });
  return {
    previewUrl: nodemailer.getTestMessageUrl(info),
    messageId: info.messageId,
  };
}
