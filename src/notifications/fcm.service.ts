import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { GoogleAuth } from 'google-auth-library';
import * as path from 'path';

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private readonly tokens: Set<string> = new Set();
  private auth: GoogleAuth | null = null;
  private projectId = '';

  constructor(private readonly httpService: HttpService) {}

  onModuleInit(): void {
    const saPath = path.resolve(
      process.cwd(),
      'firebase-service-account.json',
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sa = require(saPath);
      this.projectId = sa.project_id;
      this.auth = new GoogleAuth({
        keyFile: saPath,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });
      this.logger.log(
        `FCM initialized for project: ${this.projectId}`,
      );
    } catch {
      this.logger.warn(
        'firebase-service-account.json not found — push notifications disabled',
      );
    }
  }

  registerToken(token: string): void {
    this.tokens.add(token);
    this.logger.log(
      `FCM token registered (${this.tokens.size} device(s))`,
    );
  }

  async sendNotification(
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.auth || this.tokens.size === 0) return;

    let accessToken: string;
    try {
      const client = await this.auth.getClient();
      const tokenResponse = await client.getAccessToken();
      accessToken = tokenResponse.token!;
    } catch (err) {
      this.logger.error('Failed to get FCM access token', err);
      return;
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;

    for (const token of this.tokens) {
      try {
        await firstValueFrom(
          this.httpService.post(
            url,
            {
              message: {
                token,
                notification: { title, body },
                data: data ?? {},
                android: {
                  priority: 'high',
                  notification: { sound: 'default' },
                },
              },
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
            },
          ),
        );
        this.logger.log(`Push sent: "${title}"`);
      } catch (err) {
        const errMsg =
          err?.response?.data?.error?.message || err?.message || '';
        this.logger.error(
          `FCM send failed: ${errMsg}`,
        );
        // Remove invalid token
        if (
          errMsg.includes('not a valid FCM') ||
          errMsg.includes('UNREGISTERED')
        ) {
          this.tokens.delete(token);
          this.logger.warn('Removed invalid FCM token');
        }
      }
    }
  }

  // Convenience methods
  async notifyTradeOpened(
    direction: string,
    symbol: string,
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
  ): Promise<void> {
    await this.sendNotification(
      `DHV Trading: ${direction}`,
      `${symbol} $${entryPrice.toFixed(2)} | SL $${stopLoss.toFixed(2)} | TP $${takeProfit.toFixed(2)}`,
      { type: 'trade_opened', direction, symbol },
    );
  }

  async notifyTradeClosed(
    direction: string,
    symbol: string,
    status: string,
    pnl: number,
  ): Promise<void> {
    const isWin = pnl >= 0;
    const statusLabel =
      status === 'CLOSED_TP'
        ? 'TP Hit'
        : status === 'CLOSED_SL'
          ? 'SL Hit'
          : 'Cerrado';
    await this.sendNotification(
      `DHV Trading: ${statusLabel}`,
      `${symbol} ${direction} | PnL: ${isWin ? '+' : ''}$${pnl.toFixed(2)}`,
      { type: 'trade_closed', direction, symbol, pnl: pnl.toString() },
    );
  }

  async notifySignalRejected(
    direction: string,
    confidence: number,
    reason: string,
  ): Promise<void> {
    await this.sendNotification(
      'DHV Trading: Señal rechazada',
      `${direction} ${(confidence * 100).toFixed(0)}% — ${reason}`,
      { type: 'signal_rejected', direction },
    );
  }
}
