import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * v2 skeleton — solo infraestructura WS.
 *
 * Los eventos del v1 (signal:new, order:update, trade:closed, gate:result,
 * analysis:complete, price:update) se removieron en la demolición. Los
 * eventos del v2 (snapshot, candle:closed, signal:update, …) se definen
 * en docs/API-CONTRACT.md y se implementan en la Fase 5 (Live + capas).
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws',
})
export class DashboardGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DashboardGateway.name);

  @WebSocketServer()
  server: Server;

  afterInit(): void {
    this.logger.log('Dashboard WebSocket gateway initialized (v2 skeleton)');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }
}
