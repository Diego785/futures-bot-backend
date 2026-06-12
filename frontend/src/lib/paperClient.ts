import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL } from './apiClient';
import type { PaperTrade } from '../features/paper/paper.types';

export interface PaperHandlers {
  onPosition: (row: PaperTrade) => void; // cada cambio de estado de una paper-position (fila completa)
  onConnected: (connected: boolean) => void;
}

/**
 * Cliente Socket.IO del paper-trading (namespace /paper). Solo ESCUCHA (el paper es observable,
 * no operable — Regla Cero): cada evento es la fila completa de la posición que cambió.
 */
export class PaperClient {
  private socket: Socket | null = null;

  connect(h: PaperHandlers): void {
    if (this.socket) return;
    const socket = io(`${API_BASE_URL}/paper`, { transports: ['websocket'], reconnection: true });
    this.socket = socket;
    socket.on('connect', () => h.onConnected(true));
    socket.on('disconnect', () => h.onConnected(false));
    socket.on('paper.position', (row: PaperTrade) => h.onPosition(row));
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
