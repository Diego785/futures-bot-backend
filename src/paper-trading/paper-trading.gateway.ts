import { Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { PaperTradeRow } from './paper-row.mapper';

/**
 * Gateway READ-ONLY del paper-trading (Socket.IO, namespace /paper). Empuja cada cambio de estado
 * de una paper-position (NEW/FILLED/CLOSED) al dashboard en tiempo real. No recibe comandos que
 * muten nada: el paper es observable, no operable (Regla Cero).
 */
@WebSocketGateway({ namespace: '/paper', cors: { origin: true } })
export class PaperTradingGateway implements OnGatewayConnection {
  private readonly logger = new Logger(PaperTradingGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    client.emit('paper.hello', { t: Date.now() });
  }

  /** Difunde el estado actual de una posición (la fila completa: niveles, porqué causal, R). */
  emitPosition(row: PaperTradeRow): void {
    this.server?.emit('paper.position', row);
  }
}
