import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WS_EVENTS } from '../common/constants/binance.constants';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws',
})
export class DashboardGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DashboardGateway.name);
  private analysisHistory: Record<string, unknown>[] = [];
  private lastGateResult: Record<string, unknown> | null = null;

  @WebSocketServer()
  server: Server;

  afterInit(): void {
    this.logger.log('Dashboard WebSocket gateway initialized');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  emitBotStatus(state: Record<string, unknown>): void {
    this.server?.emit(WS_EVENTS.BOT_STATUS, state);
  }

  emitSignal(signal: Record<string, unknown>): void {
    this.server?.emit(WS_EVENTS.SIGNAL_NEW, signal);
  }

  emitOrderUpdate(data: Record<string, unknown>): void {
    this.server?.emit(WS_EVENTS.ORDER_UPDATE, data);
  }

  emitPositionUpdate(position: Record<string, unknown>): void {
    this.server?.emit(WS_EVENTS.POSITION_UPDATE, position);
  }

  emitTradeClosed(trade: Record<string, unknown>): void {
    this.server?.emit(WS_EVENTS.TRADE_CLOSED, trade);
  }

  emitError(message: string): void {
    this.server?.emit(WS_EVENTS.ERROR, {
      message,
      timestamp: Date.now(),
    });
  }

  emitGateResult(result: Record<string, unknown>): void {
    this.lastGateResult = result;
    this.server?.emit(WS_EVENTS.GATE_RESULT, result);
  }

  emitAnalysisComplete(data: Record<string, unknown>): void {
    this.analysisHistory.unshift(data);
    if (this.analysisHistory.length > 50) this.analysisHistory.length = 50;
    this.server?.emit(WS_EVENTS.ANALYSIS_COMPLETE, data);
  }

  emitPriceUpdate(symbol: string, price: number): void {
    this.server?.emit(WS_EVENTS.PRICE_UPDATE, { symbol, price });
  }

  // REST accessors
  getLastAnalysis(): Record<string, unknown> | null {
    return this.analysisHistory[0] ?? null;
  }

  getAnalysisHistory(): Record<string, unknown>[] {
    return this.analysisHistory;
  }

  getLastGateResult(): Record<string, unknown> | null {
    return this.lastGateResult;
  }
}
